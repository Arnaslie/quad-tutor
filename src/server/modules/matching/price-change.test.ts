import assert from "node:assert/strict";
import { test } from "node:test";

import { priceChangeForStudent, priceChangeForTutor } from "./price-change";

test("a raise tells the student the old and new price and that they can pick someone else", () => {
  assert.equal(
    priceChangeForStudent({ tutorName: "Sam", askedMinor: 3_500, quotedMinor: 4_000 }),
    "Sam raised their price from $35.00 to $40.00 a session since you asked. You can still pick someone else.",
  );
});

test("a cut tells the student the old and new price", () => {
  assert.equal(
    priceChangeForStudent({ tutorName: "Sam", askedMinor: 4_000, quotedMinor: 3_500 }),
    "Sam lowered their price from $40.00 to $35.00 a session since you asked.",
  );
});

test("an unchanged price says nothing", () => {
  assert.equal(priceChangeForStudent({ tutorName: "Sam", askedMinor: 3_500, quotedMinor: 3_500 }), null);
  assert.equal(priceChangeForTutor({ askedMinor: 3_500, currentMinor: 3_500 }), null);
});

test("a request sent before asked prices were stored says nothing", () => {
  assert.equal(priceChangeForStudent({ tutorName: "Sam", askedMinor: null, quotedMinor: 4_000 }), null);
  assert.equal(priceChangeForTutor({ askedMinor: null, currentMinor: 4_000 }), null);
});

test("the tutor sees the price the student asked at and the price they will pay", () => {
  assert.equal(
    priceChangeForTutor({ askedMinor: 3_500, currentMinor: 4_000 }),
    "They asked when your price was $35.00. They will see your new price, $40.00, before they pay.",
  );
});
