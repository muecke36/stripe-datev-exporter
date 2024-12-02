const stripe = require("stripe");
const { DateTime } = require("luxon");
const decimal = require("decimal.js");
const math = require("mathjs");
const datedelta = require("datedelta");
const recognition = require("recognition");
const csv = require("csv");
const customer = require("./customer");
const output = require("./output");
const dateparser = require("./dateparser");
const config = require("./config");

let invoices_cached = {};

async function* listFinalizedInvoices(fromTime, toTime) {
  const invoices = stripe.invoices.list({
    created: {
      lt: Math.floor(toTime.toSeconds()),
      gte: Math.floor((fromTime - datedelta.MONTH).toSeconds()),
    },
    expand: ["data.customer", "data.customer.tax_ids"],
  });

  for await (const invoice of invoices.autoPagingEach()) {
    if (invoice.status === "draft") {
      continue;
    }
    const finalized_date = DateTime.fromSeconds(
      invoice.status_transitions.finalized_at
    ).setZone(config.accounting_tz);
    if (finalized_date < fromTime || finalized_date >= toTime) {
      continue;
    }
    invoices_cached[invoice.id] = invoice;
    yield invoice;
  }
}

function retrieveInvoice(id) {
  if (typeof id === "string") {
    if (id in invoices_cached) {
      return invoices_cached[id];
    }
    const invoice = stripe.invoices.retrieve(id, {
      expand: ["customer", "customer.tax_ids"],
    });
    invoices_cached[invoice.id] = invoice;
    return invoice;
  } else if (id instanceof stripe.Invoice) {
    invoices_cached[id.id] = id;
    return id;
  } else {
    throw new Error(`Unexpected retrieveInvoice() argument: ${id}`);
  }
}

let tax_rates_cached = {};

function retrieveTaxRate(id) {
  if (id in tax_rates_cached) {
    return tax_rates_cached[id];
  }
  const tax_rate = stripe.taxRates.retrieve(id);
  tax_rates_cached[id] = tax_rate;
  return tax_rate;
}

function getLineItemRecognitionRange(line_item, invoice) {
  const created = DateTime.fromSeconds(invoice.created).setZone("UTC");

  let start = null;
  let end = null;
  if ("period" in line_item) {
    start = DateTime.fromSeconds(line_item.period.start).setZone("UTC");
    end = DateTime.fromSeconds(line_item.period.end).setZone("UTC");
  }
  if (start === end) {
    start = null;
    end = null;
  }

  if (start === null && end === null) {
    try {
      const date_range = dateparser.find_date_range(
        line_item.description,
        created,
        { tz: config.accounting_tz }
      );
      if (date_range !== null) {
        [start, end] = date_range;
      }
    } catch (ex) {
      console.error(ex);
    }
  }

  if (start === null && end === null) {
    console.warn(
      "Warning: unknown period for line item --",
      invoice.id,
      line_item.description
    );
    start = created;
    end = created;
  }

  return [
    start.setZone(config.accounting_tz),
    end.setZone(config.accounting_tz),
  ];
}

async function createRevenueItems(invs) {
  const revenue_items = [];
  for (const invoice of invs) {
    if (invoice.metadata["stripe-datev-exporter:ignore"] === "true") {
      console.log(`Skipping invoice ${invoice.id} (ignore)`);
      continue;
    }

    let voided_at = null;
    let marked_uncollectible_at = null;
    if (invoice.status === "void") {
      voided_at = DateTime.fromSeconds(
        invoice.status_transitions.voided_at
      ).setZone(config.accounting_tz);
    } else if (invoice.status === "uncollectible") {
      marked_uncollectible_at = DateTime.fromSeconds(
        invoice.status_transitions.marked_uncollectible_at
      ).setZone(config.accounting_tz);
    }

    let credited_at = null;
    let credited_amount = null;
    if (invoice.post_payment_credit_notes_amount > 0) {
      const cns = await stripe.creditNotes.list({ invoice: invoice.id });
      assert(cns.data.length === 1);
      credited_at = DateTime.fromSeconds(cns.data[0].created).setZone(
        config.accounting_tz
      );
      credited_amount = new decimal.Decimal(
        invoice.post_payment_credit_notes_amount
      ).div(100);
    }

    const line_items = [];

    const cus = customer.retrieveCustomer(invoice.customer);
    const accounting_props = customer.getAccountingProps(cus, { invoice });
    const amount_with_tax = new decimal.Decimal(invoice.total).div(100);
    let amount_net = amount_with_tax;
    if (invoice.tax) {
      amount_net = amount_net.sub(new decimal.Decimal(invoice.tax).div(100));
    }

    let tax_percentage = null;
    if (invoice.total_tax_amounts.length > 0) {
      const rate = retrieveTaxRate(invoice.total_tax_amounts[0].tax_rate);
      tax_percentage = new decimal.Decimal(rate.percentage);
    }

    const finalized_date = DateTime.fromSeconds(
      invoice.status_transitions.finalized_at
    ).setZone(config.accounting_tz);

    const is_subscription = invoice.subscription !== null;

    const lines = invoice.lines.has_more
      ? invoice.lines.list().autoPagingEach()
      : invoice.lines;

    for (const [line_item_idx, line_item] of lines.entries()) {
      const text = `Invoice ${invoice.number} / ${line_item.description || ""}`;
      const [start, end] = getLineItemRecognitionRange(line_item, invoice);

      let li_amount_net = new decimal.Decimal(line_item.amount).div(100);
      for (const discount of line_item.discount_amounts) {
        li_amount_net = li_amount_net.sub(
          new decimal.Decimal(discount.amount).div(100)
        );
      }

      let li_amount_with_tax = li_amount_net;
      for (const tax_amount of line_item.tax_amounts) {
        if (tax_amount.inclusive) {
          li_amount_net = li_amount_net.sub(
            new decimal.Decimal(tax_amount.amount).div(100)
          );
        } else {
          li_amount_with_tax = li_amount_with_tax.add(
            new decimal.Decimal(tax_amount.amount).div(100)
          );
        }
      }

      line_items.push({
        line_item_idx,
        recognition_start: start,
        recognition_end: end,
        amount_net: li_amount_net,
        text,
        amount_with_tax: li_amount_with_tax,
      });
    }

    revenue_items.push({
      id: invoice.id,
      number: invoice.number,
      created: finalized_date,
      amount_net,
      accounting_props,
      customer: cus,
      amount_with_tax,
      tax_percentage,
      text: `Invoice ${invoice.number}`,
      voided_at,
      credited_at,
      credited_amount,
      marked_uncollectible_at,
      line_items,
      is_subscription,
    });
  }

  return revenue_items;
}

function createAccountingRecords(revenue_item) {
  const {
    created,
    amount_with_tax,
    accounting_props,
    line_items,
    text,
    voided_at = null,
    credited_at = null,
    credited_amount = null,
    marked_uncollectible_at = null,
    number,
  } = revenue_item;
  const eu_vat_id = accounting_props.vat_id || "";

  const records = [];

  if (amount_with_tax.gt(0)) {
    records.push({
      date: created,
      "Umsatz (ohne Soll/Haben-Kz)": output.formatDecimal(amount_with_tax),
      "Soll/Haben-Kennzeichen": "S",
      "WKZ Umsatz": "EUR",
      Konto: accounting_props.customer_account,
      "Gegenkonto (ohne BU-Schlüssel)": accounting_props.revenue_account,
      "BU-Schlüssel": accounting_props.datev_tax_key,
      Buchungstext: text,
      "Belegfeld 1": number,
      "EU-Land u. UStID": eu_vat_id,
    });

    if (voided_at !== null) {
      console.log("Voided", text, "Created", created, "Voided", voided_at);
      records.push({
        date: voided_at,
        "Umsatz (ohne Soll/Haben-Kz)": output.formatDecimal(amount_with_tax),
        "Soll/Haben-Kennzeichen": "H",
        "WKZ Umsatz": "EUR",
        Konto: accounting_props.customer_account,
        "Gegenkonto (ohne BU-Schlüssel)": accounting_props.revenue_account,
        "BU-Schlüssel": accounting_props.datev_tax_key,
        Buchungstext: `Storno ${text}`,
        "Belegfeld 1": number,
        "EU-Land u. UStID": eu_vat_id,
      });
    } else if (marked_uncollectible_at !== null) {
      console.log(
        "Uncollectible",
        text,
        "Created",
        created,
        "Marked uncollectible",
        marked_uncollectible_at
      );
      records.push({
        date: marked_uncollectible_at,
        "Umsatz (ohne Soll/Haben-Kz)": output.formatDecimal(amount_with_tax),
        "Soll/Haben-Kennzeichen": "H",
        "WKZ Umsatz": "EUR",
        Konto: accounting_props.customer_account,
        "Gegenkonto (ohne BU-Schlüssel)": accounting_props.revenue_account,
        "BU-Schlüssel": accounting_props.datev_tax_key,
        Buchungstext: `Storno ${text}`,
        "Belegfeld 1": number,
        "EU-Land u. UStID": eu_vat_id,
      });
    } else if (credited_at !== null) {
      console.log(
        "Refunded",
        text,
        "Created",
        created,
        "Refunded",
        credited_at
      );
      records.push({
        date: credited_at,
        "Umsatz (ohne Soll/Haben-Kz)": output.formatDecimal(credited_amount),
        "Soll/Haben-Kennzeichen": "H",
        "WKZ Umsatz": "EUR",
        Konto: accounting_props.customer_account,
        "Gegenkonto (ohne BU-Schlüssel)": accounting_props.revenue_account,
        "BU-Schlüssel": accounting_props.datev_tax_key,
        Buchungstext: `Erstattung ${text}`,
        "Belegfeld 1": number,
        "EU-Land u. UStID": eu_vat_id,
      });
    }
  }

  if (
    (voided_at !== null &&
      voided_at.toFormat("yyyy-MM") === created.toFormat("yyyy-MM")) ||
    (marked_uncollectible_at !== null &&
      marked_uncollectible_at.toFormat("yyyy-MM") ===
        created.toFormat("yyyy-MM")) ||
    (credited_at !== null &&
      credited_at.toFormat("yyyy-MM") === created.toFormat("yyyy-MM") &&
      credited_amount.eq(amount_with_tax))
  ) {
    return records;
  }

  if (config.accounts.prap.length > 0) {
    for (const line_item of line_items) {
      const { amount_with_tax, recognition_start, recognition_end, text } =
        line_item;

      const months = recognition.split_months(
        recognition_start,
        recognition_end,
        [amount_with_tax]
      );

      const base_months = months.filter((month) => month.start <= created);
      const base_amount = base_months.reduce(
        (sum, month) => sum.add(month.amounts[0]),
        new decimal.Decimal(0)
      );

      const forward_amount = amount_with_tax.sub(base_amount);

      const forward_months = months.filter((month) => month.start > created);

      if (forward_months.length > 0 && !forward_amount.eq(0)) {
        records.push({
          date: created,
          "Umsatz (ohne Soll/Haben-Kz)": output.formatDecimal(forward_amount),
          "Soll/Haben-Kennzeichen": "S",
          "WKZ Umsatz": "EUR",
          Konto: accounting_props.revenue_account,
          "Gegenkonto (ohne BU-Schlüssel)": config.accounts.prap,
          Buchungstext: `pRAP nach ${
            forward_months.length > 1
              ? `${forward_months[0].start.toFormat(
                  "yyyy-MM"
                )}..${forward_months[forward_months.length - 1].start.toFormat(
                  "yyyy-MM"
                )}`
              : forward_months[0].start.toFormat("yyyy-MM")
          } / ${text}`,
          "Belegfeld 1": number,
          "EU-Land u. UStID": eu_vat_id,
        });

        for (const month of forward_months) {
          records.push({
            date:
              voided_at ||
              marked_uncollectible_at ||
              credited_at ||
              month.start,
            "Umsatz (ohne Soll/Haben-Kz)": output.formatDecimal(
              month.amounts[0]
            ),
            "Soll/Haben-Kennzeichen": "S",
            "WKZ Umsatz": "EUR",
            Konto: config.accounts.prap,
            "Gegenkonto (ohne BU-Schlüssel)": accounting_props.revenue_account,
            Buchungstext: `pRAP aus ${created.toFormat("yyyy-MM")} / ${text}`,
            "Belegfeld 1": number,
            "EU-Land u. UStID": eu_vat_id,
          });
        }
      }
    }
  }

  return records;
}

function to_csv(inv) {
  const lines = [
    [
      "invoice_id",
      "invoice_number",
      "date",
      "total_before_tax",
      "tax",
      "tax_percent",
      "total",
      "customer_id",
      "customer_name",
      "country",
      "vat_region",
      "vat_id",
      "tax_exempt",
      "customer_account",
      "revenue_account",
      "datev_tax_key",
    ],
  ];
  for (const invoice of inv) {
    if (invoice.status === "void") {
      continue;
    }
    const cus = customer.retrieveCustomer(invoice.customer);
    const props = customer.getAccountingProps(cus, { invoice });

    const total = new decimal.Decimal(invoice.total).div(100);
    const tax = invoice.tax ? new decimal.Decimal(invoice.tax).div(100) : null;
    const total_before_tax = total;
    if (tax !== null) {
      total_before_tax.sub(tax);
    }

    lines.push([
      invoice.id,
      invoice.number,
      DateTime.fromSeconds(invoice.status_transitions.finalized_at)
        .setZone(config.accounting_tz)
        .toFormat("yyyy-MM-dd"),
      total_before_tax.toFixed(2),
      tax ? tax.toFixed(2) : null,
      invoice.tax_percent ? invoice.tax_percent.toFixed(0) : null,
      total.toFixed(2),
      cus.id,
      customer.getCustomerName(cus),
      props.country,
      props.vat_region,
      props.vat_id,
      props.tax_exempt,
      props.customer_account,
      props.revenue_account,
      props.datev_tax_key,
    ]);
  }

  return csv.lines_to_csv(lines);
}

function to_recognized_month_csv2(revenue_items) {
  const lines = [
    [
      "invoice_id",
      "invoice_number",
      "invoice_date",
      "recognition_start",
      "recognition_end",
      "recognition_month",
      "line_item_idx",
      "line_item_desc",
      "line_item_net",
      "customer_id",
      "customer_name",
      "country",
      "accounting_date",
      "revenue_type",
      "is_recurring",
    ],
  ];

  for (const revenue_item of revenue_items) {
    const {
      amount_with_tax,
      voided_at = null,
      credited_at = null,
      credited_amount = null,
      marked_uncollectible_at = null,
    } = revenue_item;

    const last_line_item_recognition_end = Math.max(
      ...revenue_item.line_items.map((line_item) => line_item.recognition_end)
    );
    const revenue_type =
      last_line_item_recognition_end !== null &&
      revenue_item.created.plus({ days: 1 }) < last_line_item_recognition_end
        ? "Prepaid"
        : "PayPerUse";
    const is_recurring = revenue_item.is_subscription || false;

    for (const line_item of revenue_item.line_items) {
      const end =
        voided_at ||
        marked_uncollectible_at ||
        credited_at ||
        line_item.recognition_end;
      for (const month of recognition.split_months(
        line_item.recognition_start,
        line_item.recognition_end,
        [line_item.amount_net]
      )) {
        const accounting_date = Math.max(
          revenue_item.created,
          end < month.start ? end : month.start
        );

        lines.push([
          revenue_item.id,
          revenue_item.number || "",
          revenue_item.created.toFormat("yyyy-MM-dd"),
          line_item.recognition_start.toFormat("yyyy-MM-dd"),
          line_item.recognition_end.toFormat("yyyy-MM-dd"),
          `${month.start.toFormat("yyyy-MM")}-01`,
          line_item.line_item_idx + 1,
          line_item.text,
          month.amounts[0].toFixed(2),
          revenue_item.customer.id,
          customer.getCustomerName(revenue_item.customer),
          revenue_item.customer.address?.country || "",
          accounting_date.toFormat("yyyy-MM-dd"),
          revenue_type,
          is_recurring ? "true" : "false",
        ]);

        if (voided_at !== null) {
          const reverse = [...lines[lines.length - 1]];
          reverse[8] = month.amounts[0].mul(-1).toFixed(2);
          reverse[12] = Math.max(
            revenue_item.created,
            end < month.end ? end : month.start
          ).toFormat("yyyy-MM-dd");
          lines.push(reverse);
        } else if (marked_uncollectible_at !== null) {
          const reverse = [...lines[lines.length - 1]];
          reverse[8] = month.amounts[0].mul(-1).toFixed(2);
          reverse[12] = Math.max(
            revenue_item.created,
            end < month.end ? end : month.start
          ).toFormat("yyyy-MM-dd");
          lines.push(reverse);
        } else if (credited_at !== null) {
          const reverse = [...lines[lines.length - 1]];
          reverse[8] = month.amounts[0]
            .mul(-1)
            .mul(credited_amount.div(amount_with_tax))
            .toFixed(2);
          reverse[12] = Math.max(
            revenue_item.created,
            end < month.end ? end : month.start
          ).toFormat("yyyy-MM-dd");
          lines.push(reverse);
        }
      }
    }
  }

  return csv.lines_to_csv(lines);
}

function roundCentsDown(dec) {
  return Math.floor(dec * 100) / 100;
}

function accrualRecords(
  invoiceDate,
  invoiceAmount,
  customerAccount,
  revenueAccount,
  text,
  firstRevenueDate,
  revenueSpreadMonths,
  includeOriginalInvoice = true
) {
  const records = [];

  if (includeOriginalInvoice) {
    records.push({
      date: invoiceDate,
      "Umsatz (ohne Soll/Haben-Kz)": output.formatDecimal(invoiceAmount),
      "Soll/Haben-Kennzeichen": "S",
      "WKZ Umsatz": "EUR",
      Konto: customerAccount,
      "Gegenkonto (ohne BU-Schlüssel)": revenueAccount,
      Buchungstext: text,
    });
  }

  const revenuePerPeriod = roundCentsDown(
    invoiceAmount.div(revenueSpreadMonths)
  );
  let accrueAmount;
  let accrueText;
  let periodsBooked;
  let periodDate;

  if (invoiceDate < firstRevenueDate) {
    accrueAmount = invoiceAmount;
    accrueText = `${text} / Rueckstellung (${revenueSpreadMonths} Monate)`;
    periodsBooked = 0;
    periodDate = firstRevenueDate;
  } else {
    accrueAmount = invoiceAmount.sub(revenuePerPeriod);
    accrueText = `${text} / Rueckstellung Anteilig (${
      revenueSpreadMonths - 1
    }/${revenueSpreadMonths} Monate)`;
    periodsBooked = 1;
    periodDate = firstRevenueDate.plus({ months: 1 });
  }

  records.push({
    date: invoiceDate,
    "Umsatz (ohne Soll/Haben-Kz)": output.formatDecimal(accrueAmount),
    "Soll/Haben-Kennzeichen": "S",
    "WKZ Umsatz": "EUR",
    Konto: revenueAccount,
    "Gegenkonto (ohne BU-Schlüssel)": config.accounts.prap,
    Buchungstext: accrueText,
  });

  let remainingAmount = accrueAmount;

  while (periodsBooked < revenueSpreadMonths) {
    const periodAmount =
      periodsBooked < revenueSpreadMonths - 1
        ? revenuePerPeriod
        : remainingAmount;

    records.push({
      date: periodDate,
      "Umsatz (ohne Soll/Haben-Kz)": output.formatDecimal(periodAmount),
      "Soll/Haben-Kennzeichen": "S",
      "WKZ Umsatz": "EUR",
      Konto: config.accounts.prap,
      "Gegenkonto (ohne BU-Schlüssel)": revenueAccount,
      Buchungstext: `${text} / Aufloesung Rueckstellung Monat ${
        periodsBooked + 1
      }/${revenueSpreadMonths}`,
    });

    periodDate = periodDate.plus({ months: 1 });
    periodsBooked += 1;
    remainingAmount = remainingAmount.sub(periodAmount);
  }

  return records;
}

async function* listCreditNotes(fromTime, toTime) {
  const creditNotes = stripe.creditNotes.list({
    expand: ["data.invoice"],
  });

  for await (const creditNote of creditNotes.autoPagingEach()) {
    const created = DateTime.fromSeconds(creditNote.created).setZone(
      config.accounting_tz
    );
    if (created >= toTime) {
      continue;
    }
    if (created < fromTime) {
      break;
    }

    yield creditNote;
  }
}
