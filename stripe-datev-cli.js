import dotenv from "dotenv";
import { argv } from "process";
import { join, dirname, resolve } from "path";
import fs from "fs";
import { DateTime } from "luxon";
import stripe from "stripe";
import {
  listFinalizedInvoices,
  createRevenueItems,
  to_csv,
  createAccountingRecords,
} from "stripe_datev.invoices";
import {
  listChargesRaw,
  createRevenueItems as createChargeRevenueItems,
  createAccountingRecords as createChargeAccountingRecords,
  chargeHasInvoice,
} from "stripe_datev.charges";
import {
  validate_customers,
  fill_account_numbers,
  list_account_numbers,
  retrieveCustomer,
} from "stripe_datev.customer";
import { listTransfersRaw } from "stripe_datev.transfers";
import {
  listPayouts,
  createAccountingRecords as createPayoutAccountingRecords,
} from "stripe_datev.payouts";
import { writeRecords } from "stripe_datev.output";
import { accounting_tz } from "stripe_datev.config";

dotenv.config();

const stripeApiKey = process.env.STRIPE_API_KEY;
if (!stripeApiKey) {
  console.error("Require STRIPE_API_KEY environment variable to be set");
  process.exit(1);
}

const stripeClient = stripe(stripeApiKey);
stripeClient.setApiVersion("2020-08-27");

const outDir = join(dirname(resolve()), "out");
if (stripeApiKey.startsWith("sk_test")) {
  outDir = join(outDir, "test");
}
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir);
}

class StripeDatevCli {
  run(argv) {
    const command = argv[2];
    if (this[command]) {
      this[command](argv.slice(3));
    } else {
      console.error(`Unknown command: ${command}`);
    }
  }

  download(argv) {
    const year = parseInt(argv[0]);
    const month = parseInt(argv[1]);

    let fromTime, toTime;
    if (month > 0) {
      fromTime = accounting_tz.localize(DateTime.local(year, month, 1));
      toTime = fromTime.plus({ months: 1 });
    } else {
      fromTime = accounting_tz.localize(DateTime.local(year, 1, 1));
      toTime = fromTime.plus({ years: 1 });
    }
    console.log(
      `Retrieving data between ${fromTime.toISODate()} and ${toTime
        .minus({ days: 1 })
        .toISODate()}`
    );
    const thisMonth = fromTime.toFormat("yyyy-MM");

    const invoices = [...listFinalizedInvoices(fromTime, toTime)].reverse();
    console.log(
      `Retrieved ${invoices.length} invoice(s), total ${invoices.reduce(
        (sum, i) => sum + i.total / 100,
        0
      )} EUR`
    );

    const revenueItems = createRevenueItems(invoices);

    const charges = listChargesRaw(fromTime, toTime);
    console.log(
      `Retrieved ${charges.length} charge(s), total ${charges.reduce(
        (sum, c) => sum + c.amount / 100,
        0
      )} EUR`
    );

    const directCharges = charges.filter((charge) => !chargeHasInvoice(charge));
    revenueItems.push(...createChargeRevenueItems(directCharges));

    const overviewDir = join(outDir, "overview");
    if (!fs.existsSync(overviewDir)) {
      fs.mkdirSync(overviewDir);
    }

    fs.writeFileSync(
      join(
        overviewDir,
        `overview-${year.toString().padStart(4, "0")}-${month
          .toString()
          .padStart(2, "0")}.csv`
      ),
      to_csv(invoices)
    );
    console.log(
      `Wrote ${invoices.length.toString().padStart(4, " ")} invoices to ${join(
        overviewDir,
        `overview-${year}-${month}.csv`
      )}`
    );

    const monthlyRecognitionDir = join(outDir, "monthly_recognition");
    if (!fs.existsSync(monthlyRecognitionDir)) {
      fs.mkdirSync(monthlyRecognitionDir);
    }

    fs.writeFileSync(
      join(monthlyRecognitionDir, `monthly_recognition-${thisMonth}.csv`),
      to_recognized_month_csv2(revenueItems)
    );
    console.log(
      `Wrote ${revenueItems.length
        .toString()
        .padStart(4, " ")} revenue items to ${join(
        monthlyRecognitionDir,
        `monthly_recognition-${thisMonth}.csv`
      )}`
    );

    const datevDir = join(outDir, "datev");
    if (!fs.existsSync(datevDir)) {
      fs.mkdirSync(datevDir);
    }

    const records = revenueItems.flatMap((revenueItem) =>
      createAccountingRecords(revenueItem)
    );

    const recordsByMonth = {};
    records.forEach((record) => {
      const month = record.date.toFormat("yyyy-MM");
      recordsByMonth[month] = recordsByMonth[month] || [];
      recordsByMonth[month].push(record);
    });

    for (const [month, records] of Object.entries(recordsByMonth)) {
      const name =
        month === thisMonth
          ? `EXTF_${thisMonth}_Revenue.csv`
          : `EXTF_${month}_Revenue_From_${thisMonth}.csv`;
      writeRecords(
        join(datevDir, name),
        records,
        `Stripe Revenue ${month} from ${thisMonth}`
      );
    }

    const chargeRecords = createChargeAccountingRecords(charges);
    const chargesByMonth = {};
    chargeRecords.forEach((record) => {
      const month = record.date.toFormat("yyyy-MM");
      chargesByMonth[month] = chargesByMonth[month] || [];
      chargesByMonth[month].push(record);
    });

    for (const [month, records] of Object.entries(chargesByMonth)) {
      const name =
        month === thisMonth
          ? `EXTF_${thisMonth}_Charges.csv`
          : `EXTF_${month}_Charges_From_${thisMonth}.csv`;
      writeRecords(
        join(datevDir, name),
        records,
        `Stripe Charges/Fees ${month} from ${thisMonth}`
      );
    }

    const transfers = listTransfersRaw(fromTime, toTime);
    console.log(
      `Retrieved ${transfers.length} transfer(s), total ${transfers.reduce(
        (sum, c) => sum + c.amount / 100,
        0
      )} EUR`
    );

    const transferRecords = createAccountingRecords(transfers);
    writeRecords(
      join(datevDir, `EXTF_${thisMonth}_Transfers.csv`),
      transferRecords,
      `Stripe Transfers ${thisMonth}`
    );

    const payoutObjects = listPayouts(fromTime, toTime);
    console.log(
      `Retrieved ${
        payoutObjects.length
      } payout(s), total ${payoutObjects.reduce(
        (sum, r) => sum + r.amount,
        0
      )} EUR`
    );

    const payoutRecords = createPayoutAccountingRecords(payoutObjects);
    writeRecords(
      join(datevDir, `EXTF_${thisMonth}_Payouts.csv`),
      payoutRecords,
      `Stripe Payouts ${thisMonth}`
    );

    const balanceTransactions = stripeClient.balanceTransactions
      .list({
        created: {
          lt: Math.floor(toTime.toSeconds()),
          gte: Math.floor(fromTime.toSeconds()),
        },
        type: "contribution",
      })
      .autoPagingIter();
    console.log(
      `Retrieved ${
        balanceTransactions.length
      } contribution(s), total ${balanceTransactions.reduce(
        (sum, b) => sum - b.amount / 100,
        0
      )} EUR`
    );

    const contributionRecords =
      createPayoutAccountingRecordsContributions(balanceTransactions);
    writeRecords(
      join(datevDir, `EXTF_${thisMonth}_Contributions.csv`),
      contributionRecords,
      `Stripe Contributions ${thisMonth}`
    );

    for (const invoice of stripeClient.invoices
      .list({
        created: {
          lt: Math.floor(fromTime.toSeconds()),
          gte: Math.floor(fromTime.minus({ months: 6 }).toSeconds()),
        },
      })
      .autoPagingIter()) {
      if (
        (invoice.status_transitions.voided_at &&
          DateTime.fromSeconds(invoice.status_transitions.voided_at) >=
            fromTime) ||
        (invoice.status_transitions.marked_uncollectible_at &&
          DateTime.fromSeconds(
            invoice.status_transitions.marked_uncollectible_at
          ) >= fromTime)
      ) {
        console.warn(
          `Warning: found earlier invoice ${
            invoice.id
          } voided or marked uncollectible in this month, consider downloading ${DateTime.fromSeconds(
            invoice.status_transitions.finalized_at
          ).toFormat("yyyy-MM")}`
        );
      }
    }

    const creditNotes = stripeClient.invoices.listCreditNotes(fromTime, toTime);
    for (const creditNote of creditNotes) {
      const invoiceFinalized = DateTime.fromSeconds(
        creditNote.invoice.status_transitions.finalized_at
      );
      if (invoiceFinalized < fromTime) {
        console.warn(
          `Warning: found credit note ${
            creditNote.number
          } for earlier invoice, consider downloading ${invoiceFinalized.toFormat(
            "yyyy-MM"
          )}`
        );
      }
    }
  }

  validate_customers() {
    validate_customers();
  }

  fill_account_numbers() {
    fill_account_numbers();
  }

  list_accounts(argv) {
    list_account_numbers(argv[0] || null);
  }

  opos(argv) {
    let ref, status;
    if (argv.length > 0) {
      ref = DateTime.fromObject({ year: argv[0], month: argv[1], day: argv[2] })
        .plus({ days: 1 })
        .minus({ seconds: 1 });
      status = null;
    } else {
      ref = DateTime.local();
      status = "open";
    }

    console.log("Unpaid invoices as of", accounting_tz.localize(ref));

    const invoices = stripeClient.invoices
      .list({
        created: {
          lte: Math.floor(ref.toSeconds()),
          gte: Math.floor(ref.minus({ years: 1 }).toSeconds()),
        },
        status: status,
        expand: ["data.customer"],
      })
      .autoPagingIter();

    const totals = [];
    for (const invoice of invoices) {
      const finalizedAt = invoice.status_transitions.finalized_at;
      if (!finalizedAt || DateTime.fromSeconds(finalizedAt) > ref) {
        continue;
      }
      const markedUncollectibleAt =
        invoice.status_transitions.marked_uncollectible_at;
      if (
        markedUncollectibleAt &&
        DateTime.fromSeconds(markedUncollectibleAt) <= ref
      ) {
        continue;
      }
      const voidedAt = invoice.status_transitions.voided_at;
      if (voidedAt && DateTime.fromSeconds(voidedAt) <= ref) {
        continue;
      }
      const paidAt = invoice.status_transitions.paid_at;
      if (paidAt && DateTime.fromSeconds(paidAt) <= ref) {
        continue;
      }

      const customer = retrieveCustomer(invoice.customer);
      const dueDate = DateTime.fromSeconds(invoice.due_date || invoice.created);
      const total = invoice.total / 100;
      totals.push(total);
      console.log(
        `${invoice.number.padEnd(13, " ")} ${total
          .toFixed(2)
          .padStart(10, " ")} EUR ${customer.email.padEnd(
          35,
          " "
        )} due ${dueDate.toISODate()} ${
          dueDate < ref ? `(${ref.diff(dueDate).toFormat("d")} overdue)` : ""
        }`
      );
    }

    const total = totals.reduce((x, y) => x + y, 0);
    console.log(`TOTAL        ${total.toFixed(2).padStart(10, " ")} EUR`);
  }
}

if (require.main === module) {
  new StripeDatevCli().run(argv);
}
