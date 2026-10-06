import { and, eq, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { engagement, sessionRating, tutorCourse } from "@/server/db/schema";
import { ratingCounted } from "@/server/modules/ratings/window";

import {
  EMPTY_POOL,
  RENEWAL_PRIOR_BP,
  STAR_PRIOR_BP,
  addPools,
  posteriorBp,
  priorBp,
  renewalPool,
  starPool,
  type Pool,
} from "./posterior";

const STATS_LOCK = 0x5343;

type Pools = { stars: Pool; renewals: Pool };

type Refreshed = {
  id: string;
  scoreSampleCount: number;
  scorePosteriorMean: number;
  renewalTrialCount: number;
  renewalPosteriorMean: number;
};

export async function refreshScores(institutionId: string): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${STATS_LOCK}::int, hashtext(${institutionId}))`);

    const ratings = tx.$with("ratings").as(
      tx
        .select({
          ratedId: sessionRating.tutorCourseId,
          count: sql<number>`count(*)::int`.as("count"),
          starSum: sql<number>`sum(${sessionRating.stars})::int`.as("star_sum"),
        })
        .from(sessionRating)
        .where(and(eq(sessionRating.institutionId, institutionId), ratingCounted))
        .groupBy(sessionRating.tutorCourseId),
    );

    const pairs = tx.$with("pairs").as(
      tx
        .select({
          pairId: engagement.tutorCourseId,
          first: sql<boolean>`row_number() over (partition by ${engagement.studentProfileId}, ${engagement.tutorCourseId} order by ${engagement.createdAt}, ${engagement.id}) = 1`.as("first"),
          ended: sql<boolean>`${engagement.status} in ('completed', 'refunded')`.as("ended"),
          renewed: sql<boolean>`count(*) over (partition by ${engagement.studentProfileId}, ${engagement.tutorCourseId}) > 1`.as("renewed"),
        })
        .from(engagement)
        .where(eq(engagement.institutionId, institutionId)),
    );

    const renewals = tx.$with("renewals").as(
      tx
        .with(pairs)
        .select({
          renewedId: pairs.pairId,
          trials: sql<number>`count(*)::int`.as("trials"),
          successes: sql<number>`(count(*) filter (where ${pairs.renewed}))::int`.as("successes"),
        })
        .from(pairs)
        .where(sql`${pairs.first} and ${pairs.ended}`)
        .groupBy(pairs.pairId),
    );

    const rows = await tx
      .with(ratings, renewals)
      .select({
        id: tutorCourse.id,
        courseId: tutorCourse.courseId,
        active: sql<boolean>`${tutorCourse.status} = 'active'`,
        count: sql<number>`coalesce(${ratings.count}, 0)`,
        starSum: sql<number>`coalesce(${ratings.starSum}, 0)`,
        trials: sql<number>`coalesce(${renewals.trials}, 0)`,
        successes: sql<number>`coalesce(${renewals.successes}, 0)`,
      })
      .from(tutorCourse)
      .leftJoin(ratings, eq(ratings.ratedId, tutorCourse.id))
      .leftJoin(renewals, eq(renewals.renewedId, tutorCourse.id))
      .where(eq(tutorCourse.institutionId, institutionId));

    const own = new Map<string, Pools>();
    const byCourse = new Map<string, Pools>();
    let campus: Pools = { stars: EMPTY_POOL, renewals: EMPTY_POOL };
    for (const row of rows) {
      const pools = { stars: starPool(row.count, row.starSum), renewals: renewalPool(row.trials, row.successes) };
      own.set(row.id, pools);
      byCourse.set(row.courseId, sum(byCourse.get(row.courseId), pools));
      campus = sum(campus, pools);
    }

    const refreshed: Refreshed[] = rows
      .filter((row) => row.active)
      .map((row) => {
        const pools = own.get(row.id)!;
        const course = byCourse.get(row.courseId)!;
        return {
          id: row.id,
          scoreSampleCount: pools.stars.samples,
          scorePosteriorMean: posteriorBp(pools.stars, priorBp(course.stars, campus.stars, STAR_PRIOR_BP)),
          renewalTrialCount: pools.renewals.samples,
          renewalPosteriorMean: posteriorBp(pools.renewals, priorBp(course.renewals, campus.renewals, RENEWAL_PRIOR_BP)),
        };
      });
    if (refreshed.length === 0) return 0;

    const changed = await tx.execute<{ id: string }>(sql`
      update ${tutorCourse} set
        score_sample_count = v.score_sample_count,
        score_posterior_mean = v.score_posterior_mean,
        renewal_trial_count = v.renewal_trial_count,
        renewal_posterior_mean = v.renewal_posterior_mean
      from jsonb_to_recordset(${JSON.stringify(refreshed.map(toColumns))}::jsonb) as v(
        id uuid, score_sample_count int, score_posterior_mean int, renewal_trial_count int, renewal_posterior_mean int
      )
      where ${tutorCourse.id} = v.id
        and ${tutorCourse.institutionId} = ${institutionId}
        and (${tutorCourse.scoreSampleCount}, ${tutorCourse.scorePosteriorMean}, ${tutorCourse.renewalTrialCount}, ${tutorCourse.renewalPosteriorMean})
          is distinct from (v.score_sample_count, v.score_posterior_mean, v.renewal_trial_count, v.renewal_posterior_mean)
      returning ${tutorCourse.id}
    `);
    return changed.length;
  });
}

function sum(a: Pools | undefined, b: Pools): Pools {
  return a ? { stars: addPools(a.stars, b.stars), renewals: addPools(a.renewals, b.renewals) } : b;
}

function toColumns(row: Refreshed) {
  return {
    id: row.id,
    score_sample_count: row.scoreSampleCount,
    score_posterior_mean: row.scorePosteriorMean,
    renewal_trial_count: row.renewalTrialCount,
    renewal_posterior_mean: row.renewalPosteriorMean,
  };
}
