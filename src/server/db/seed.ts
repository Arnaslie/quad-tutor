import { and, count, eq, getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { db } from "./index";
import {
  course,
  courseCodeAlias,
  courseOffering,
  enrollment,
  exam,
  institution,
  professor,
  studentProfile,
  term,
  tutorAvailability,
  tutorCourse,
  tutorProfile,
  user,
} from "./schema";

const INSTITUTION = {
  name: "The University of Alabama",
  slug: "ua",
  emailDomain: "crimson.ua.edu",
  timezone: "America/Chicago",
};

const TERMS = [
  { name: "Fall 2024", startsOn: "2024-08-21", endsOn: "2024-12-13" },
  { name: "Spring 2025", startsOn: "2025-01-08", endsOn: "2025-05-02" },
  { name: "Fall 2025", startsOn: "2025-08-20", endsOn: "2025-12-12" },
  { name: "Spring 2026", startsOn: "2026-01-07", endsOn: "2026-05-01" },
  { name: "Fall 2026", startsOn: "2026-08-19", endsOn: "2026-12-11" },
] as const;

type TermName = (typeof TERMS)[number]["name"];

const CURRENT_TERM: TermName = "Fall 2026";

const EARLIEST_TERM: TermName = "Fall 2024";

const PROFESSORS = [
  { name: "Ellen Whitaker", department: "Mathematics" },
  { name: "Marcus Doyle", department: "Mathematics" },
  { name: "Priya Raman", department: "Mathematics" },
  { name: "Alan Brackett", department: "Chemistry" },
  { name: "Nina Ferraro", department: "Chemistry" },
  { name: "Grace Holloway", department: "Biological Sciences" },
  { name: "Samuel Ortiz", department: "Biological Sciences" },
  { name: "Ruth Kaplan", department: "Physics and Astronomy" },
  { name: "Dale Simmons", department: "Accounting" },
  { name: "Carla Nunez", department: "Economics" },
  { name: "Jae-Won Park", department: "Computer Science" },
  { name: "Bethany Cole", department: "Computer Science" },
  { name: "Omar Haddad", department: "Statistics" },
] as const;

type ProfessorName = (typeof PROFESSORS)[number]["name"];

type CourseFixture = {
  title: string;
  department: string;

  code: string;
  codeSince: TermName;

  formerCodes: readonly { code: string; from: TermName; to: TermName }[];
  offerings: readonly { section: string; professor: ProfessorName }[];
  exams: readonly { name: string; occursOn: string }[];
};

const COURSES = {
  math125: {
    title: "Calculus I",
    department: "Mathematics",
    code: "MATH 125",
    codeSince: EARLIEST_TERM,
    formerCodes: [],
    offerings: [
      { section: "001", professor: "Ellen Whitaker" },
      { section: "002", professor: "Marcus Doyle" },
      { section: "003", professor: "Priya Raman" },
    ],
    exams: [
      { name: "Exam 1", occursOn: "2026-09-11" },
      { name: "Exam 2", occursOn: "2026-10-02" },
      { name: "Exam 3", occursOn: "2026-11-06" },
      { name: "Final Exam", occursOn: "2026-12-09" },
    ],
  },
  math126: {
    title: "Calculus II",
    department: "Mathematics",
    code: "MATH 126",
    codeSince: EARLIEST_TERM,
    formerCodes: [],
    offerings: [
      { section: "001", professor: "Marcus Doyle" },
      { section: "002", professor: "Ellen Whitaker" },
    ],
    exams: [
      { name: "Exam 1", occursOn: "2026-09-14" },
      { name: "Exam 2", occursOn: "2026-10-05" },
      { name: "Exam 3", occursOn: "2026-11-09" },
      { name: "Final Exam", occursOn: "2026-12-10" },
    ],
  },
  ch101: {
    title: "General Chemistry I",
    department: "Chemistry",
    code: "CH 101",
    codeSince: EARLIEST_TERM,
    formerCodes: [],
    offerings: [
      { section: "001", professor: "Alan Brackett" },
      { section: "002", professor: "Nina Ferraro" },
    ],
    exams: [
      { name: "Exam 1", occursOn: "2026-09-15" },
      { name: "Exam 2", occursOn: "2026-10-06" },
      { name: "Exam 3", occursOn: "2026-11-10" },
      { name: "Final Exam", occursOn: "2026-12-08" },
    ],
  },
  ch102: {
    title: "General Chemistry II",
    department: "Chemistry",
    code: "CH 102",
    codeSince: EARLIEST_TERM,
    formerCodes: [],
    offerings: [{ section: "001", professor: "Nina Ferraro" }],
    exams: [
      { name: "Exam 1", occursOn: "2026-09-16" },
      { name: "Exam 2", occursOn: "2026-10-07" },
      { name: "Exam 3", occursOn: "2026-11-11" },
      { name: "Final Exam", occursOn: "2026-12-09" },
    ],
  },
  bsc114: {
    title: "Principles of Biology I",
    department: "Biological Sciences",
    code: "BSC 114",
    codeSince: EARLIEST_TERM,
    formerCodes: [],
    offerings: [
      { section: "001", professor: "Grace Holloway" },
      { section: "002", professor: "Samuel Ortiz" },
    ],
    exams: [
      { name: "Exam 1", occursOn: "2026-09-17" },
      { name: "Exam 2", occursOn: "2026-10-08" },
      { name: "Exam 3", occursOn: "2026-11-12" },
      { name: "Final Exam", occursOn: "2026-12-07" },
    ],
  },
  bsc116: {
    title: "Principles of Biology II",
    department: "Biological Sciences",
    code: "BSC 116",
    codeSince: EARLIEST_TERM,
    formerCodes: [],
    offerings: [{ section: "001", professor: "Samuel Ortiz" }],
    exams: [
      { name: "Exam 1", occursOn: "2026-09-18" },
      { name: "Exam 2", occursOn: "2026-10-09" },
      { name: "Exam 3", occursOn: "2026-11-13" },
      { name: "Final Exam", occursOn: "2026-12-11" },
    ],
  },
  ph105: {
    title: "General Physics I with Calculus",
    department: "Physics and Astronomy",
    code: "PH 105",
    codeSince: EARLIEST_TERM,
    formerCodes: [],
    offerings: [{ section: "001", professor: "Ruth Kaplan" }],
    exams: [
      { name: "Exam 1", occursOn: "2026-09-10" },
      { name: "Exam 2", occursOn: "2026-10-01" },
      { name: "Exam 3", occursOn: "2026-11-05" },
      { name: "Final Exam", occursOn: "2026-12-08" },
    ],
  },
  ac210: {
    title: "Introduction to Accounting",
    department: "Accounting",
    code: "AC 210",
    codeSince: EARLIEST_TERM,
    formerCodes: [],
    offerings: [{ section: "001", professor: "Dale Simmons" }],
    exams: [
      { name: "Exam 1", occursOn: "2026-09-09" },
      { name: "Exam 2", occursOn: "2026-09-30" },
      { name: "Exam 3", occursOn: "2026-11-04" },
      { name: "Final Exam", occursOn: "2026-12-10" },
    ],
  },
  ec110: {
    title: "Principles of Microeconomics",
    department: "Economics",
    code: "EC 110",
    codeSince: CURRENT_TERM,
    formerCodes: [{ code: "ECON 110", from: EARLIEST_TERM, to: "Spring 2026" }],
    offerings: [
      { section: "001", professor: "Carla Nunez" },
      { section: "002", professor: "Carla Nunez" },
    ],
    exams: [
      { name: "Exam 1", occursOn: "2026-09-08" },
      { name: "Exam 2", occursOn: "2026-09-29" },
      { name: "Exam 3", occursOn: "2026-11-03" },
      { name: "Final Exam", occursOn: "2026-12-07" },
    ],
  },
  cs100: {
    title: "Computer Science Principles",
    department: "Computer Science",
    code: "CS 100",
    codeSince: EARLIEST_TERM,
    formerCodes: [],
    offerings: [{ section: "001", professor: "Bethany Cole" }],
    exams: [
      { name: "Exam 1", occursOn: "2026-09-21" },
      { name: "Exam 2", occursOn: "2026-10-19" },
      { name: "Final Exam", occursOn: "2026-12-11" },
    ],
  },
  cs201: {
    title: "Data Structures and Algorithms",
    department: "Computer Science",
    code: "CS 201",
    codeSince: CURRENT_TERM,
    formerCodes: [{ code: "CS 285", from: EARLIEST_TERM, to: "Spring 2026" }],
    offerings: [{ section: "001", professor: "Jae-Won Park" }],
    exams: [
      { name: "Exam 1", occursOn: "2026-09-23" },
      { name: "Exam 2", occursOn: "2026-10-21" },
      { name: "Exam 3", occursOn: "2026-11-18" },
      { name: "Final Exam", occursOn: "2026-12-09" },
    ],
  },
  st260: {
    title: "Statistical Data Analysis",
    department: "Statistics",
    code: "ST 260",
    codeSince: EARLIEST_TERM,
    formerCodes: [],
    offerings: [{ section: "001", professor: "Omar Haddad" }],
    exams: [
      { name: "Exam 1", occursOn: "2026-09-22" },
      { name: "Exam 2", occursOn: "2026-10-20" },
      { name: "Final Exam", occursOn: "2026-12-10" },
    ],
  },
} as const satisfies Record<string, CourseFixture>;

type CourseKey = keyof typeof COURSES;

function window_(weekday: number, start: string, end: string) {
  return { weekday, startMinute: minuteOfDay(start), endMinute: minuteOfDay(end) };
}

function minuteOfDay(hhmm: string): number {
  const [hours, mins] = hhmm.split(":").map(Number);
  return hours * 60 + mins;
}

type TutorFixture = {
  key: string;
  name: string;
  email: string;
  headline: string;
  bio: string;
  graduatesOn: string;
  courses: readonly {
    course: CourseKey;
    grade: string;
    takenTerm: TermName;

    takenUnder: ProfessorName | null;
    status?: "active" | "pending_verification";
  }[];
  availability: readonly { weekday: number; startMinute: number; endMinute: number }[];
};

const TUTORS: readonly TutorFixture[] = [
  {
    key: "maya-chen",
    name: "Maya Chen",
    email: "maya.chen@crimson.ua.edu",
    headline: "Econ major, TA for intro micro",
    bio: "I took EC 110 with Nunez and still have every problem set I wrote.",
    graduatesOn: "2028-05-06",
    courses: [{ course: "ec110", grade: "A-", takenTerm: "Fall 2025", takenUnder: "Carla Nunez" }],
    availability: [window_(1, "18:00", "21:00"), window_(3, "18:00", "21:00")],
  },
  {
    key: "devin-parker",
    name: "Devin Parker",
    email: "devin.parker@crimson.ua.edu",
    headline: "Math and econ, calc tutor since sophomore year",
    bio: "Whitaker's exams reuse the same four proof shapes. I can show you which.",
    graduatesOn: "2027-05-08",
    courses: [
      { course: "math125", grade: "A", takenTerm: "Fall 2025", takenUnder: "Ellen Whitaker" },
      { course: "ec110", grade: "A", takenTerm: "Fall 2024", takenUnder: null },
    ],
    availability: [window_(2, "16:00", "20:00"), window_(4, "16:00", "20:00"), window_(0, "13:00", "17:00")],
  },
  {
    key: "aisha-bello",
    name: "Aisha Bello",
    email: "aisha.bello@crimson.ua.edu",
    headline: "Mechanical engineering, calc sequence start to finish",
    bio: "Took 125 and 126 back to back under Doyle. The curve is not what people think.",
    graduatesOn: "2027-12-11",
    courses: [
      { course: "math125", grade: "A-", takenTerm: "Spring 2026", takenUnder: "Marcus Doyle" },
      { course: "math126", grade: "A", takenTerm: "Fall 2025", takenUnder: "Marcus Doyle" },
    ],
    availability: [window_(1, "09:00", "12:00"), window_(5, "14:00", "18:00")],
  },
  {
    key: "luis-moreno",
    name: "Luis Moreno",
    email: "luis.moreno@crimson.ua.edu",
    headline: "Physics major who lives in the math building",
    bio: "Series and sequences are where 126 loses people. That is most of what I do.",
    graduatesOn: "2027-05-08",
    courses: [
      { course: "math125", grade: "A", takenTerm: "Spring 2025", takenUnder: "Ellen Whitaker" },
      { course: "math126", grade: "A-", takenTerm: "Spring 2026", takenUnder: "Priya Raman" },
    ],
    availability: [window_(3, "19:00", "22:00"), window_(6, "10:00", "14:00")],
  },
  {
    key: "hannah-kim",
    name: "Hannah Kim",
    email: "hannah.kim@crimson.ua.edu",
    headline: "CS, and I still remember Raman's quiz format",
    bio: "I tutor 125 and 201. Both are pacing problems more than concept problems.",
    graduatesOn: "2027-05-08",
    courses: [
      { course: "math125", grade: "A+", takenTerm: "Fall 2024", takenUnder: "Priya Raman" },
      { course: "cs201", grade: "A", takenTerm: "Fall 2025", takenUnder: "Jae-Won Park" },
    ],
    availability: [window_(2, "18:00", "21:00"), window_(4, "18:00", "21:00")],
  },
  {
    key: "tyler-boone",
    name: "Tyler Boone",
    email: "tyler.boone@crimson.ua.edu",
    headline: "Junior, engineering",
    bio: "Second-attempt student turned tutor. I know exactly where it goes wrong.",
    graduatesOn: "2028-05-06",
    courses: [
      { course: "math125", grade: "A", takenTerm: "Spring 2026", takenUnder: null },

      {
        course: "ph105",
        grade: "A-",
        takenTerm: "Spring 2026",
        takenUnder: "Ruth Kaplan",
        status: "pending_verification",
      },
    ],
    availability: [window_(5, "15:00", "19:00")],
  },
  {
    key: "priyanka-shah",
    name: "Priyanka Shah",
    email: "priyanka.shah@crimson.ua.edu",
    headline: "Stats major, R and calc",
    bio: "Haddad's data analysis projects are graded on writeups, not code. Nobody tells you that.",
    graduatesOn: "2027-12-11",
    courses: [
      { course: "math125", grade: "A-", takenTerm: "Fall 2025", takenUnder: "Marcus Doyle" },
      { course: "st260", grade: "A", takenTerm: "Spring 2026", takenUnder: "Omar Haddad" },
    ],
    availability: [window_(1, "13:00", "16:00"), window_(3, "13:00", "16:00")],
  },
  {
    key: "jordan-ellis",
    name: "Jordan Ellis",
    email: "jordan.ellis@crimson.ua.edu",
    headline: "Pre-med, general chemistry",
    bio: "Brackett writes the same stoichiometry trap every term. Once you see it you stop falling for it.",
    graduatesOn: "2027-05-08",
    courses: [{ course: "ch101", grade: "A", takenTerm: "Spring 2026", takenUnder: "Alan Brackett" }],
    availability: [window_(2, "17:00", "20:00"), window_(6, "11:00", "15:00")],
  },
  {
    key: "sofia-marek",
    name: "Sofia Marek",
    email: "sofia.marek@crimson.ua.edu",
    headline: "Chemistry major, both semesters of gen chem",
    bio: "Ferraro's lab writeups are half the grade and almost nobody optimises for them.",
    graduatesOn: "2027-12-11",
    courses: [
      { course: "ch101", grade: "A-", takenTerm: "Fall 2025", takenUnder: "Nina Ferraro" },
      { course: "ch102", grade: "A", takenTerm: "Spring 2026", takenUnder: "Nina Ferraro" },
    ],
    availability: [window_(0, "14:00", "18:00"), window_(4, "19:00", "22:00")],
  },
  {
    key: "caleb-nguyen",
    name: "Caleb Nguyen",
    email: "caleb.nguyen@crimson.ua.edu",
    headline: "CS and chem double major",
    bio: "I took gen chem a while ago, so I am cheap and patient.",
    graduatesOn: "2027-05-08",
    courses: [
      { course: "ch101", grade: "A", takenTerm: "Fall 2024", takenUnder: "Alan Brackett" },
      { course: "cs201", grade: "A-", takenTerm: "Spring 2026", takenUnder: "Bethany Cole" },
    ],
    availability: [window_(3, "16:00", "19:00")],
  },
  {
    key: "rachel-owusu",
    name: "Rachel Owusu",
    email: "rachel.owusu@crimson.ua.edu",
    headline: "Biochem, gen chem I and II",
    bio: "Titration curves, equilibrium, and the two weeks of kinetics that sink people.",
    graduatesOn: "2028-05-06",
    courses: [
      { course: "ch101", grade: "A", takenTerm: "Spring 2026", takenUnder: null },
      { course: "ch102", grade: "A-", takenTerm: "Fall 2025", takenUnder: "Alan Brackett" },
    ],
    availability: [window_(1, "19:00", "22:00"), window_(5, "12:00", "16:00")],
  },
  {
    key: "ben-castillo",
    name: "Ben Castillo",
    email: "ben.castillo@crimson.ua.edu",
    headline: "Biology, and the intro CS course",
    bio: "Holloway tests vocabulary harder than mechanism. Study accordingly.",
    graduatesOn: "2027-12-11",
    courses: [
      { course: "bsc114", grade: "A", takenTerm: "Fall 2025", takenUnder: "Grace Holloway" },
      { course: "cs100", grade: "A", takenTerm: "Spring 2026", takenUnder: "Bethany Cole" },
    ],
    availability: [window_(2, "14:00", "17:00"), window_(4, "14:00", "17:00")],
  },
  {
    key: "nora-fitzgerald",
    name: "Nora Fitzgerald",
    email: "nora.fitzgerald@crimson.ua.edu",
    headline: "Neuroscience, intro bio",
    bio: "Ortiz's section moves fast through genetics. I have the timeline written down.",
    graduatesOn: "2028-05-06",
    courses: [{ course: "bsc114", grade: "A-", takenTerm: "Spring 2026", takenUnder: "Samuel Ortiz" }],
    availability: [window_(6, "09:00", "13:00")],
  },
  {
    key: "isaac-levin",
    name: "Isaac Levin",
    email: "isaac.levin@crimson.ua.edu",
    headline: "CS with a bio minor",
    bio: "Recursion and pointers, or cell respiration. Odd pairing, same explanation style.",
    graduatesOn: "2027-05-08",
    courses: [
      { course: "bsc114", grade: "A", takenTerm: "Spring 2025", takenUnder: null },
      { course: "cs201", grade: "A", takenTerm: "Spring 2025", takenUnder: "Jae-Won Park" },
    ],
    availability: [window_(1, "16:00", "19:00"), window_(3, "20:00", "22:00")],
  },
  {
    key: "grace-whitfield",
    name: "Grace Whitfield",
    email: "grace.whitfield@crimson.ua.edu",
    headline: "Finance, micro and stats",
    bio: "Graphs first, algebra second. Micro gets much easier in that order.",
    graduatesOn: "2027-05-08",
    courses: [
      { course: "ec110", grade: "A", takenTerm: "Spring 2026", takenUnder: "Carla Nunez" },
      { course: "st260", grade: "A-", takenTerm: "Fall 2024", takenUnder: null },
    ],
    availability: [window_(0, "16:00", "20:00"), window_(2, "19:00", "22:00")],
  },
];

const STUDENT_ONLY = [
  { key: "owen-drake", name: "Owen Drake", email: "owen.drake@crimson.ua.edu" },
  { key: "talia-reyes", name: "Talia Reyes", email: "talia.reyes@crimson.ua.edu" },
] as const;

const ENROLLMENTS: readonly { person: string; course: CourseKey; section: string }[] = [
  { person: "maya-chen", course: "math125", section: "002" },
  { person: "maya-chen", course: "cs100", section: "001" },
  { person: "maya-chen", course: "ph105", section: "001" },
  { person: "owen-drake", course: "ch101", section: "001" },
  { person: "owen-drake", course: "st260", section: "001" },
  { person: "owen-drake", course: "ac210", section: "001" },
  { person: "talia-reyes", course: "bsc114", section: "002" },
  { person: "talia-reyes", course: "ch102", section: "001" },
  { person: "talia-reyes", course: "bsc116", section: "001" },
];

const VERIFIED_AT = new Date("2026-08-01T12:00:00.000Z");

type IdRow = { id: string };

const owned = new Map<string, Set<string>>();

function record(table: PgTable, id: string): string {
  const name = getTableName(table);
  const ids = owned.get(name) ?? new Set<string>();
  ids.add(id);
  owned.set(name, ids);
  return id;
}

async function ensureId(
  table: PgTable,
  find: PromiseLike<IdRow[]>,
  create: () => PromiseLike<IdRow[]>,
): Promise<string> {
  const existing = (await find).at(0);
  if (existing) return record(table, existing.id);

  const created = (await create()).at(0);
  if (!created) throw new Error("insert returned no row");
  return record(table, created.id);
}

async function seedInstitution(): Promise<string> {
  const [row] = await db
    .insert(institution)
    .values(INSTITUTION)
    .onConflictDoUpdate({
      target: institution.slug,
      set: {
        name: INSTITUTION.name,
        emailDomain: INSTITUTION.emailDomain,
        timezone: INSTITUTION.timezone,
      },
    })
    .returning({ id: institution.id });

  return record(institution, row.id);
}

async function seedTerms(institutionId: string): Promise<Map<TermName, string>> {
  const ids = new Map<TermName, string>();

  for (const fixture of TERMS) {
    const id = await ensureId(
      term,
      db
        .select({ id: term.id })
        .from(term)
        .where(and(eq(term.institutionId, institutionId), eq(term.name, fixture.name))),
      () =>
        db
          .insert(term)
          .values({ institutionId, ...fixture })
          .returning({ id: term.id }),
    );
    ids.set(fixture.name, id);
  }

  return ids;
}

async function seedProfessors(institutionId: string): Promise<Map<ProfessorName, string>> {
  const ids = new Map<ProfessorName, string>();

  for (const fixture of PROFESSORS) {
    const id = await ensureId(
      professor,
      db
        .select({ id: professor.id })
        .from(professor)
        .where(and(eq(professor.institutionId, institutionId), eq(professor.name, fixture.name))),
      () =>
        db
          .insert(professor)
          .values({ institutionId, ...fixture })
          .returning({ id: professor.id }),
    );
    ids.set(fixture.name, id);
  }

  return ids;
}

async function seedCourses(
  institutionId: string,
  terms: Map<TermName, string>,
  professors: Map<ProfessorName, string>,
): Promise<{ courses: Map<CourseKey, string>; offerings: Map<string, string> }> {
  const courses = new Map<CourseKey, string>();
  const offerings = new Map<string, string>();

  for (const [key, fixture] of Object.entries(COURSES) as [CourseKey, CourseFixture][]) {
    const courseId = await ensureId(
      course,
      db
        .select({ id: course.id })
        .from(course)
        .where(
          and(
            eq(course.institutionId, institutionId),
            eq(course.department, fixture.department),
            eq(course.title, fixture.title),
          ),
        ),
      () =>
        db
          .insert(course)
          .values({
            institutionId,
            title: fixture.title,
            department: fixture.department,
            isSeeded: true,
          })
          .returning({ id: course.id }),
    );
    courses.set(key, courseId);

    await seedAlias(courseId, fixture.code, terms.get(fixture.codeSince)!, null);
    for (const former of fixture.formerCodes) {
      await seedAlias(courseId, former.code, terms.get(former.from)!, terms.get(former.to)!);
    }

    for (const offering of fixture.offerings) {
      const offeringId = await ensureId(
        courseOffering,
        db
          .select({ id: courseOffering.id })
          .from(courseOffering)
          .where(
            and(
              eq(courseOffering.courseId, courseId),
              eq(courseOffering.termId, terms.get(CURRENT_TERM)!),
              eq(courseOffering.section, offering.section),
            ),
          ),
        () =>
          db
            .insert(courseOffering)
            .values({
              courseId,
              termId: terms.get(CURRENT_TERM)!,
              professorId: professors.get(offering.professor)!,
              section: offering.section,
            })
            .returning({ id: courseOffering.id }),
      );
      offerings.set(offeringKey(key, offering.section), offeringId);

      for (const fixtureExam of fixture.exams) {
        await ensureId(
          exam,
          db
            .select({ id: exam.id })
            .from(exam)
            .where(
              and(eq(exam.courseOfferingId, offeringId), eq(exam.name, fixtureExam.name)),
            ),
          () =>
            db
              .insert(exam)
              .values({ courseOfferingId: offeringId, ...fixtureExam })
              .returning({ id: exam.id }),
        );
      }
    }
  }

  return { courses, offerings };
}

async function seedAlias(
  courseId: string,
  code: string,
  validFromTermId: string,
  validToTermId: string | null,
): Promise<void> {
  await ensureId(
    courseCodeAlias,
    db
      .select({ id: courseCodeAlias.id })
      .from(courseCodeAlias)
      .where(and(eq(courseCodeAlias.courseId, courseId), eq(courseCodeAlias.code, code))),
    () =>
      db
        .insert(courseCodeAlias)
        .values({ courseId, code, validFromTermId, validToTermId })
        .returning({ id: courseCodeAlias.id }),
  );
}

function offeringKey(course: CourseKey, section: string): string {
  return `${course}/${section}`;
}

type Person = { userId: string; studentProfileId: string; tutorProfileId: string | null };

async function seedPerson(
  institutionId: string,
  person: { key: string; name: string; email: string },
): Promise<Person> {
  const userId = await ensureId(
    user,
    db.select({ id: user.id }).from(user).where(eq(user.email, person.email)),
    () =>
      db
        .insert(user)
        .values({
          id: `seed_${person.key}`,
          name: person.name,
          email: person.email,

          emailVerified: true,
        })
        .returning({ id: user.id }),
  );

  const studentProfileId = await ensureId(
    studentProfile,
    db.select({ id: studentProfile.id }).from(studentProfile).where(eq(studentProfile.userId, userId)),
    () =>
      db
        .insert(studentProfile)
        .values({ userId, institutionId })
        .returning({ id: studentProfile.id }),
  );

  return { userId, studentProfileId, tutorProfileId: null };
}

async function seedTutors(
  institutionId: string,
  courses: Map<CourseKey, string>,
  terms: Map<TermName, string>,
  professors: Map<ProfessorName, string>,
): Promise<Map<string, Person>> {
  const people = new Map<string, Person>();

  for (const fixture of TUTORS) {
    const person = await seedPerson(institutionId, fixture);

    const tutorProfileId = await ensureId(
      tutorProfile,
      db.select({ id: tutorProfile.id }).from(tutorProfile).where(eq(tutorProfile.userId, person.userId)),
      () =>
        db
          .insert(tutorProfile)
          .values({
            userId: person.userId,
            institutionId,
            headline: fixture.headline,
            bio: fixture.bio,
            expectedGraduationOn: fixture.graduatesOn,
          })
          .returning({ id: tutorProfile.id }),
    );

    people.set(fixture.key, { ...person, tutorProfileId });

    for (const claim of fixture.courses) {
      const status = claim.status ?? "active";
      await ensureId(
        tutorCourse,
        db
          .select({ id: tutorCourse.id })
          .from(tutorCourse)
          .where(
            and(
              eq(tutorCourse.tutorProfileId, tutorProfileId),
              eq(tutorCourse.courseId, courses.get(claim.course)!),
            ),
          ),
        () =>
          db
            .insert(tutorCourse)
            .values({
              tutorProfileId,
              courseId: courses.get(claim.course)!,
              gradeEarned: claim.grade,
              takenTermId: terms.get(claim.takenTerm)!,
              takenUnderProfessorId: claim.takenUnder ? professors.get(claim.takenUnder)! : null,
              verifiedAt: status === "active" ? VERIFIED_AT : null,
              status,
            })
            .returning({ id: tutorCourse.id }),
      );
    }

    for (const slot of fixture.availability) {
      await ensureId(
        tutorAvailability,
        db
          .select({ id: tutorAvailability.id })
          .from(tutorAvailability)
          .where(
            and(
              eq(tutorAvailability.tutorProfileId, tutorProfileId),
              eq(tutorAvailability.weekday, slot.weekday),
              eq(tutorAvailability.startMinute, slot.startMinute),
            ),
          ),
        () =>
          db
            .insert(tutorAvailability)
            .values({ tutorProfileId, ...slot })
            .returning({ id: tutorAvailability.id }),
      );
    }
  }

  return people;
}

async function seedEnrollments(
  people: Map<string, Person>,
  offerings: Map<string, string>,
): Promise<void> {
  for (const row of ENROLLMENTS) {
    const person = people.get(row.person);
    if (!person) throw new Error(`enrollment references unknown person: ${row.person}`);

    const courseOfferingId = offerings.get(offeringKey(row.course, row.section))!;

    await ensureId(
      enrollment,
      db
        .select({ id: enrollment.id })
        .from(enrollment)
        .where(
          and(
            eq(enrollment.studentProfileId, person.studentProfileId),
            eq(enrollment.courseOfferingId, courseOfferingId),
          ),
        ),
      () =>
        db
          .insert(enrollment)
          .values({ studentProfileId: person.studentProfileId, courseOfferingId })
          .returning({ id: enrollment.id }),
    );
  }
}

const COUNTED_TABLES: PgTable[] = [
  institution,
  term,
  professor,
  course,
  courseCodeAlias,
  courseOffering,
  exam,
  user,
  studentProfile,
  tutorProfile,
  tutorCourse,
  tutorAvailability,
  enrollment,
];

async function report(institutionId: string, courses: Map<CourseKey, string>): Promise<void> {
  for (const table of COUNTED_TABLES) {
    const label = getTableName(table);
    const [row] = await db.select({ n: count() }).from(table);
    const seeded = owned.get(label)?.size ?? 0;
    const extra = row.n > seeded ? `  (${row.n} in table)` : "";
    console.log(`  ${label.padEnd(20)} ${String(seeded).padStart(4)} seeded${extra}`);
  }

  console.log("\nsupply per course (active tutors → presentation):");
  for (const [key, fixture] of Object.entries(COURSES) as [CourseKey, CourseFixture][]) {
    const [row] = await db
      .select({ n: count() })
      .from(tutorCourse)
      .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
      .where(
        and(
          eq(tutorCourse.courseId, courses.get(key)!),
          eq(tutorCourse.status, "active"),
          eq(tutorProfile.institutionId, institutionId),
        ),
      );

    console.log(`  ${fixture.code.padEnd(10)} ${String(row.n).padStart(2)}  ${presentationFor(row.n)}`);
  }
}

function presentationFor(tutors: number): string {
  if (tutors === 0) return "demand_capture";
  if (tutors <= 2) return "single_reveal";
  return "deck";
}

/**
 * The campus: institution, terms, professors, courses, aliases, offerings,
 * exams. Facts about a university, safe anywhere — this is the part a catalog
 * API eventually replaces.
 */
async function seedCatalog() {
  const institutionId = await seedInstitution();
  const terms = await seedTerms(institutionId);
  const professors = await seedProfessors(institutionId);
  const { courses, offerings } = await seedCourses(institutionId, terms, professors);
  return { institutionId, terms, professors, courses, offerings };
}

/**
 * Fixture people. Local and pre-release only: these are invented tutors with
 * addresses on a real university domain, so they must never exist on a campus
 * with actual students on it.
 */
async function seedPeople(
  catalog: Awaited<ReturnType<typeof seedCatalog>>,
): Promise<void> {
  const people = await seedTutors(
    catalog.institutionId,
    catalog.courses,
    catalog.terms,
    catalog.professors,
  );
  for (const student of STUDENT_ONLY) {
    people.set(student.key, await seedPerson(catalog.institutionId, student));
  }
  await seedEnrollments(people, catalog.offerings);
}

async function main(): Promise<void> {
  const catalogOnly = process.argv.includes("--catalog");

  const catalog = await seedCatalog();
  if (!catalogOnly) await seedPeople(catalog);

  console.log(`\nseeded ${INSTITUTION.name} (${INSTITUTION.emailDomain})${catalogOnly ? " — catalog only" : ""}\n`);
  await report(catalog.institutionId, catalog.courses);
  console.log(
    catalogOnly
      ? "\nno accounts created. Anyone with a campus address can sign up."
      : "\nsign in locally with any seeded address — the magic link prints to the dev server log.",
  );
}

main()
  .then(() => db.$client.end())
  .catch(async (error) => {
    console.error(error);
    await db.$client.end();
    process.exitCode = 1;
  });
