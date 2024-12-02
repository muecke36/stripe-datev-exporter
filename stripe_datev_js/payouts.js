const stripe = require("stripe");
const { DateTime } = require("luxon");
const output = require("./output");
const config = require("./config");

function listPayouts(fromTime, toTime) {
  return stripe.payouts
    .list({
      created: {
        gte: Math.floor(fromTime.toSeconds()),
        lt: Math.floor(toTime.toSeconds()),
      },
      expand: ["data.balance_transaction"],
    })
    .autoPagingToArray()
    .then((payouts) => {
      return payouts
        .filter((payout) => payout.status === "paid")
        .map((payout) => {
          if (payout.currency !== "eur") {
            throw new Error("Unexpected currency");
          }
          if (payout.balance_transaction.fee_details.length !== 0) {
            throw new Error("Unexpected fee details");
          }
          return {
            id: payout.id,
            amount: Number(payout.amount) / 100,
            arrival_date: DateTime.fromSeconds(payout.created).toUTC(),
            description: payout.description,
          };
        });
    });
}

function createAccountingRecords(payouts) {
  return payouts.map((payout) => {
    const text = `Stripe Payout ${payout.id} / ${payout.description || ""}`;
    return {
      date: payout.arrival_date,
      "Umsatz (ohne Soll/Haben-Kz)": output.formatDecimal(payout.amount),
      "Soll/Haben-Kennzeichen": "S",
      "WKZ Umsatz": "EUR",
      Konto: config.accounts.transit.toString(),
      "Gegenkonto (ohne BU-Schlüssel)": config.accounts.bank.toString(),
      Buchungstext: text,
    };
  });
}

function createAccountingRecordsContributions(balance_transactions) {
  return balance_transactions.map((balance_transaction) => {
    return {
      date: DateTime.fromSeconds(balance_transaction.created).toUTC(),
      "Umsatz (ohne Soll/Haben-Kz)": output.formatDecimal(
        -Number(balance_transaction.amount) / 100
      ),
      "Soll/Haben-Kennzeichen": "S",
      "WKZ Umsatz": "EUR",
      Konto: config.accounts.contributions.toString(),
      "Gegenkonto (ohne BU-Schlüssel)": config.accounts.bank.toString(),
      Buchungstext: `Stripe ${
        balance_transaction.description || "Contribution"
      } ${balance_transaction.id}`,
    };
  });
}

module.exports = {
  listPayouts,
  createAccountingRecords,
  createAccountingRecordsContributions,
};
