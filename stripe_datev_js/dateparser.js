const assert = require("assert");
const moment = require("moment-timezone");

const MONTHS = [
  ["Jan", "January"],
  ["Feb", "February"],
  ["Mar", "March"],
  ["Apr", "April"],
  ["May"],
  ["Jun", "June"],
  ["Jul", "July"],
  ["Aug", "August"],
  ["Sep", "Sept", "September"],
  ["Oct", "October"],
  ["Nov", "November"],
  ["Dec", "December"],
];

const YEARS = Array.from(
  { length: moment().year() - 2020 + 1 },
  (_, i) => 2020 + i
);

function flatten(t) {
  return t.reduce((acc, val) => acc.concat(val), []);
}

const YEAR_REGEX = new RegExp(`(?<=[\\D^])(${YEARS.join("|")})(?=\\D|$)`, "gm");
const MONTH_REGEX = new RegExp(
  `(?<=[\\W^])(${flatten(MONTHS).join("|")})(?=\\W|$)`,
  "gm"
);
const DAY_REGEX = /(?<=[\D^])([0-9]{1,2})(?:st|nd|rd|th)(?=\W|$)/gm;

function findDateRange(text, refDate = null, tz = null) {
  const years = [...text.matchAll(YEAR_REGEX)].map((match) =>
    parseInt(match[1])
  );
  const months = [...text.matchAll(MONTH_REGEX)].map((match) => {
    for (let [monthIdx, patterns] of MONTHS.entries()) {
      if (
        patterns.some((pattern) => new RegExp(`^${pattern}$`).test(match[1]))
      ) {
        return monthIdx + 1;
      }
    }
  });
  const days = [...text.matchAll(DAY_REGEX)].map((match) => parseInt(match[1]));

  let foundYear = true;
  let year1, year2;
  if (years.length >= 2) {
    [year1, year2] = years;
  } else if (years.length === 1) {
    year1 = year2 = years[0];
  } else {
    if (!refDate) return null;
    foundYear = false;
    year1 = year2 = refDate.year();
  }

  let month1, month2;
  if (months.length >= 2) {
    [month1, month2] = months;
  } else if (months.length === 1) {
    month1 = month2 = months[0];
  } else {
    if (!foundYear) return null;
    if (days.length > 0) return null;
    month1 = 1;
    month2 = 12;
  }

  let day1, day2;
  if (days.length >= 2) {
    [day1, day2] = days;
  } else if (days.length === 1) {
    day1 = day2 = days[0];
  } else {
    day1 = 1;
    day2 = moment(`${year2}-${month2}`, "YYYY-MM").daysInMonth();
  }

  let start = moment({
    year: year1,
    month: month1 - 1,
    day: day1,
    hour: 0,
    minute: 0,
    second: 0,
  });
  let end = moment({
    year: year2,
    month: month2 - 1,
    day: day2,
    hour: 23,
    minute: 59,
    second: 59,
  });

  if (tz) {
    start = start.tz(tz);
    end = end.tz(tz);
  }

  return [start, end];
}

describe("DateParser", function () {
  const refDate = moment("2021-05-10");
  const tz = "Europe/Berlin";

  function assertStringRange(strRange, start, end) {
    const r = findDateRange(strRange, refDate, tz);
    if (r === null) {
      assert.strictEqual(start, null, "Could not parse range");
      assert.strictEqual(end, null, "Could not parse range");
    } else {
      assert.notStrictEqual(start, null, "Did not expect start of range");
      assert.notStrictEqual(end, null, "Did not expect end of range");
      assert.strictEqual(
        r[0].isSame(moment.tz(start, tz)),
        true,
        `Start of range does not match: '${strRange}'`
      );
      assert.strictEqual(
        r[1].isSame(moment.tz(end, tz)),
        true,
        `End of range does not match: '${strRange}'`
      );
    }
  }

  it("should parse dates correctly", function () {
    assertStringRange(
      "Njord Analytics and Player; (Cape31); Fri May 7th 2021",
      moment("2021-05-07"),
      moment("2021-05-07").endOf("day")
    );

    assertStringRange(
      "Njord Analytics & Njord Player, RC44, valid Jan-Nov 2021",
      moment("2021-01-01"),
      moment("2021-11-30").endOf("day")
    );

    assertStringRange(
      "Njord Player & Fleet Race reports, per day, May 20th-23rd",
      moment("2021-05-20"),
      moment("2021-05-23").endOf("day")
    );

    assertStringRange(
      "Njord Player, SailGP, valid Jun 1st 2021 – Apr 30th 2022",
      moment("2021-06-01"),
      moment("2022-04-30").endOf("day")
    );

    assertStringRange(
      "Njord Analytics and Player; (ClubSwan 36); Tue Jun 22nd 2021",
      moment("2021-06-22"),
      moment("2021-06-22").endOf("day")
    );

    assertStringRange(
      "Njord Analytics & Njord Player; 2x Laser Radial; valid November 1st 2021 to December 31st 2024 (price per year)",
      moment("2021-11-01"),
      moment("2024-12-31").endOf("day")
    );

    assertStringRange(
      "Njord Player, TP52, Menorca (Sat 25th - 30th 2021)",
      null,
      null
    );

    assertStringRange(
      "Njord Analytics and Player; M32; valid Sept 1st 2021 - Sept 4th 2022",
      moment("2021-09-01"),
      moment("2022-09-04").endOf("day")
    );

    assertStringRange(
      "Njord Analytics & Njord Player, SailGP (8 boats), valid Jan 1st 2022 - Mar 31st 2022 (incl. loading all data from 2021/22 SailGP season)",
      moment("2022-01-01"),
      moment("2022-03-31").endOf("day")
    );
  });
});
