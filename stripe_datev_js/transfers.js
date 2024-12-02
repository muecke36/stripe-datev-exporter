const stripe = require("stripe");
const { DateTime } = require("luxon");
const { customer, dateparser, output, config, invoices } = require("./");

function* listTransfersRaw(fromTime, toTime) {
  const transfers = stripe.transfers
    .list({
      created: {
        gte: Math.floor(fromTime.toSeconds()),
        lt: Math.floor(toTime.toSeconds()),
      },
      expand: [
        "data.destination",
        "data.source_transaction",
        "data.source_transaction.invoice",
      ],
    })
    .autoPagingToArray({ limit: Infinity });

  for (const transfer of transfers) {
    if (transfer.reversed) {
      continue;
    }
    yield transfer;
  }
}

function createAccountingRecords(transfers) {
  const records = [];

  for (const transfer of transfers) {
    const created = DateTime.fromSeconds(transfer.created).setZone(
      config.accounting_tz
    );

    const netAmount =
      transfer.amount -
      (transfer.source_transaction?.application_fee_amount || 0);

    const invoice = transfer.source_transaction?.invoice;
    const invoiceNumber = invoice?.number;

    records.push({
      date: created,
      "Umsatz (ohne Soll/Haben-Kz)": output.formatDecimal(netAmount / 100),
      "Soll/Haben-Kennzeichen": "S",
      "WKZ Umsatz": "EUR",
      Konto: config.accounts.external_services.toString(),
      "Gegenkonto (ohne BU-Schlüssel)":
        transfer.destination.metadata.accountNumber,
      Buchungstext: `Fremdleistung ${invoiceNumber || transfer.id} anteilig`,
      "Belegfeld 1": transfer.id,
    });

    records.push({
      date: created,
      "Umsatz (ohne Soll/Haben-Kz)": output.formatDecimal(netAmount / 100),
      "Soll/Haben-Kennzeichen": "S",
      "WKZ Umsatz": "EUR",
      Konto: transfer.destination.metadata.accountNumber,
      "Gegenkonto (ohne BU-Schlüssel)": config.accounts.bank.toString(),
      Buchungstext: `Fremdleistung ${invoiceNumber || transfer.id} anteilig`,
      "Belegfeld 1": transfer.id,
    });
  }

  return records;
}

module.exports = {
  listTransfersRaw,
  createAccountingRecords,
};
