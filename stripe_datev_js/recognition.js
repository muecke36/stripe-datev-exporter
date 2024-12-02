const assert = require("assert");
const moment = require("moment");
const Decimal = require("decimal.js");

function splitMonths(start, end, amounts) {
  amounts = amounts.map((amount) => new Decimal(amount));

  if (start.isSame(end)) {
    return [
      {
        start: start,
        end: end,
        amounts: amounts,
      },
    ];
  }

  const totalDuration = moment.duration(end.diff(start));
  let currentMonth = start.clone();

  let remainingAmounts = [...amounts];
  let months = [];

  while (currentMonth.isSameOrBefore(end)) {
    const startOfMonth = currentMonth.clone().startOf("month");
    const endOfMonth = currentMonth.clone().endOf("month");

    const monthDuration = moment
      .duration(
        moment.min(end, endOfMonth).diff(moment.max(start, startOfMonth))
      )
      .add(1, "second");

    const percOfTotal = new Decimal(monthDuration.asSeconds()).div(
      totalDuration.asSeconds()
    );

    const monthAmounts = amounts.map((amount) =>
      amount.mul(percOfTotal).toDecimalPlaces(2)
    );

    remainingAmounts = remainingAmounts.map((remainingAmount, idx) =>
      remainingAmount.minus(monthAmounts[idx])
    );

    months.push({
      start: startOfMonth,
      end: endOfMonth,
      amounts: monthAmounts,
    });

    currentMonth.add(1, "month");
  }

  months[months.length - 1].amounts = months[months.length - 1].amounts.map(
    (monthAmount, idx) => monthAmount.plus(remainingAmounts[idx])
  );

  if (months[months.length - 1].amounts.every((amount) => amount.isZero())) {
    months.pop();
  }

  amounts.forEach((amount, idx) => {
    assert(
      amount.equals(
        months.reduce(
          (sum, month) => sum.plus(month.amounts[idx]),
          new Decimal(0)
        )
      )
    );
  });

  return months;
}

describe("Recognition Test Suite", function () {
  it("should split months correctly", function () {
    const result = splitMonths(moment("2021-05-01"), moment("2022-04-30"), [
      new Decimal(100),
    ]);

    assert.deepStrictEqual(result, [
      {
        start: moment("2021-05-01T00:00:00"),
        end: moment("2021-05-31T23:59:59"),
        amounts: [new Decimal("8.52")],
      },
      {
        start: moment("2021-06-01T00:00:00"),
        end: moment("2021-06-30T23:59:59"),
        amounts: [new Decimal("8.24")],
      },
      {
        start: moment("2021-07-01T00:00:00"),
        end: moment("2021-07-31T23:59:59"),
        amounts: [new Decimal("8.52")],
      },
      {
        start: moment("2021-08-01T00:00:00"),
        end: moment("2021-08-31T23:59:59"),
        amounts: [new Decimal("8.52")],
      },
      {
        start: moment("2021-09-01T00:00:00"),
        end: moment("2021-09-30T23:59:59"),
        amounts: [new Decimal("8.24")],
      },
      {
        start: moment("2021-10-01T00:00:00"),
        end: moment("2021-10-31T23:59:59"),
        amounts: [new Decimal("8.52")],
      },
      {
        start: moment("2021-11-01T00:00:00"),
        end: moment("2021-11-30T23:59:59"),
        amounts: [new Decimal("8.24")],
      },
      {
        start: moment("2021-12-01T00:00:00"),
        end: moment("2021-12-31T23:59:59"),
        amounts: [new Decimal("8.52")],
      },
      {
        start: moment("2022-01-01T00:00:00"),
        end: moment("2022-01-31T23:59:59"),
        amounts: [new Decimal("8.52")],
      },
      {
        start: moment("2022-02-01T00:00:00"),
        end: moment("2022-02-28T23:59:59"),
        amounts: [new Decimal("7.69")],
      },
      {
        start: moment("2022-03-01T00:00:00"),
        end: moment("2022-03-31T23:59:59"),
        amounts: [new Decimal("8.52")],
      },
      {
        start: moment("2022-04-01T00:00:00"),
        end: moment("2022-04-30T23:59:59"),
        amounts: [new Decimal("7.95")],
      },
    ]);
  });
});

if (require.main === module) {
  const Mocha = require("mocha");
  const mocha = new Mocha();
  mocha.addFile(__filename);
  mocha.run();
}
