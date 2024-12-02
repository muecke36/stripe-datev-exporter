const stripe = require("stripe");
const { Decimal } = require("decimal.js");
const { DateTime } = require("luxon");
const { customer, dateparser, output, config, invoices } = require(".");

function* listChargesRaw(fromTime, toTime) {
  const charges = stripe.charges
    .list({
      created: {
        gte: Math.floor(fromTime.toSeconds()),
        lt: Math.floor(toTime.toSeconds()),
      },
      expand: ["data.customer", "data.customer.tax_ids", "data.invoice"],
    })
    .autoPagingIterator();

  for (const charge of charges) {
    if (!charge.paid || !charge.captured) continue;
    yield charge;
  }
}

function chargeHasInvoice(charge) {
  return charge.invoice !== null;
}

const checkoutSessionsByPaymentIntent = {};

async function getCheckoutSessionViaPaymentIntentCached(id) {
  if (id in checkoutSessionsByPaymentIntent) {
    return checkoutSessionsByPaymentIntent[id];
  }
  const sessions = await stripe.checkout.sessions.list({
    payment_intent: id,
    expand: ["data.line_items"],
  });
  const session = sessions.data.length > 0 ? sessions.data[0] : null;
  checkoutSessionsByPaymentIntent[id] = session;
  return session;
}

async function getChargeDescription(charge) {
  if (!charge.description && charge.payment_intent) {
    try {
      const session = await getCheckoutSessionViaPaymentIntentCached(
        charge.payment_intent
      );
      return session.line_items.data.map((li) => li.description).join(", ");
    } catch (error) {
      // Handle error
    }
  }
  return charge.description;
}

function getChargeRecognitionRange(charge) {
  const desc = getChargeDescription(charge);
  const created = DateTime.fromSeconds(charge.created).setZone("utc");
  const dateRange = dateparser.findDateRange(desc, created, {
    zone: config.accounting_tz,
  });
  if (dateRange !== null) {
    return dateRange;
  } else {
    console.warn(`Warning: unknown period for charge -- ${charge.id} ${desc}`);
    return [created, created];
  }
}

async function createRevenueItems(charges) {
  const revenueItems = [];
  for (const charge of charges) {
    if (charge.refunded) {
      if (charge.refunds.data[0].amount === charge.amount) {
        console.log(`Skipping fully refunded charge ${charge.id}`);
        continue;
      } else {
        throw new Error(
          "Handling of partially refunded charges is not implemented yet"
        );
      }
    }
    if (charge.description && charge.description.includes("in_")) {
      console.log(
        `Skipping charge referencing invoice ${charge.id} ${charge.description}`
      );
      continue;
    }

    const cus = await customer.retrieveCustomer(charge.customer);
    const session = await getCheckoutSessionViaPaymentIntentCached(
      charge.payment_intent
    );

    const accountingProps = customer.getAccountingProps(cus, {
      checkout_session: session,
    });
    let text = charge.receipt_number
      ? `Receipt ${charge.receipt_number}`
      : `Charge ${charge.id}`;

    const description = await getChargeDescription(charge);
    if (description) {
      text += ` / ${description}`;
    }

    const created = DateTime.fromSeconds(charge.created).setZone("utc");
    const [start, end] = getChargeRecognitionRange(charge);

    const chargeAmount = new Decimal(charge.amount).div(100);
    const taxAmount = session
      ? new Decimal(session.total_details.amount_tax).div(100)
      : null;
    const netAmount =
      taxAmount !== null ? chargeAmount.minus(taxAmount) : chargeAmount;

    const taxPercentage =
      taxAmount === null ? null : taxAmount.div(netAmount).times(100);

    revenueItems.push({
      id: charge.id,
      number: charge.receipt_number,
      created,
      amount_net: netAmount,
      accounting_props: accountingProps,
      customer: cus,
      amount_with_tax: chargeAmount,
      tax_percentage: taxPercentage,
      text,
      line_items: [
        {
          recognition_start: start,
          recognition_end: end,
          amount_net: netAmount,
          text,
          amount_with_tax: chargeAmount,
        },
      ],
    });
  }

  return revenueItems;
}

async function createAccountingRecords(charges) {
  const records = [];

  for (const charge of charges) {
    const accProps = customer.getAccountingProps(
      await customer.retrieveCustomer(charge.customer)
    );
    const created = DateTime.fromSeconds(charge.created).setZone(
      config.accounting_tz
    );

    const balanceTransaction = await stripe.balanceTransactions.retrieve(
      charge.balance_transaction
    );

    let number;
    if (charge.invoice) {
      const invoice = await invoices.retrieveInvoice(charge.invoice);
      number = invoice.number;
    } else {
      number = charge.receipt_number;
    }

    records.push({
      date: created,
      "Umsatz (ohne Soll/Haben-Kz)": output.formatDecimal(
        new Decimal(charge.amount).div(100)
      ),
      "Soll/Haben-Kennzeichen": "S",
      "WKZ Umsatz": "EUR",
      Konto: config.accounts.bank.toString(),
      "Gegenkonto (ohne BU-Schlüssel)": accProps.customer_account,
      Buchungstext: `Stripe Payment (${charge.id})`,
      "Belegfeld 1": number,
    });

    for (const fee of balanceTransaction.fee_details) {
      if (fee.currency !== "eur") throw new Error("Unexpected fee currency");
      records.push({
        date: created,
        "Umsatz (ohne Soll/Haben-Kz)": output.formatDecimal(
          new Decimal(fee.amount).div(100)
        ),
        "Soll/Haben-Kennzeichen": "S",
        "WKZ Umsatz": "EUR",
        Konto: config.accounts.stripe_fees.toString(),
        "Gegenkonto (ohne BU-Schlüssel)": config.accounts.bank.toString(),
        Buchungstext: `${fee.description || "Stripe Fee"} (${charge.id})`,
      });
    }

    if (charge.refunded || charge.refunds.data.length > 0) {
      if (charge.refunds.data.length !== 1)
        throw new Error("Unexpected number of refunds");
      const refund = charge.refunds.data[0];

      const refundCreated = DateTime.fromSeconds(refund.created).setZone("utc");
      records.push({
        date: refundCreated,
        "Umsatz (ohne Soll/Haben-Kz)": output.formatDecimal(
          new Decimal(refund.amount).div(100)
        ),
        "Soll/Haben-Kennzeichen": "H",
        "WKZ Umsatz": "EUR",
        Konto: config.accounts.bank.toString(),
        "Gegenkonto (ohne BU-Schlüssel)": accProps.customer_account,
        Buchungstext: `Stripe Payment Refund (${charge.id})`,
        "Belegfeld 1": number,
      });
    }
  }

  return records;
}

module.exports = {
  listChargesRaw,
  chargeHasInvoice,
  getCheckoutSessionViaPaymentIntentCached,
  getChargeDescription,
  getChargeRecognitionRange,
  createRevenueItems,
  createAccountingRecords,
};
