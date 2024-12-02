const { DateTime } = require("luxon");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { config, output } = require("./stripe_datev");

const customersCached = new Map();

async function retrieveCustomer(id) {
  if (typeof id === "string") {
    if (customersCached.has(id)) {
      return customersCached.get(id);
    }
    const cus = await stripe.customers.retrieve(id, { expand: ["tax_ids"] });
    customersCached.set(cus.id, cus);
    return cus;
  } else if (id instanceof stripe.Customer) {
    customersCached.set(id.id, id);
    return id;
  } else {
    throw new Error(`Unexpected retrieveCustomer() argument: ${id}`);
  }
}

function getCustomerName(customer) {
  if (customer.deleted) {
    return customer.id;
  }
  return customer.description || customer.name;
}

const taxIdsCached = new Map();

async function getCustomerTaxId(customer) {
  if ("tax_ids" in customer) {
    const taxId = customer.tax_ids.data.find(
      (taxId) =>
        taxId.type === "eu_vat" && taxId.verification.status === "verified"
    );
    return taxId ? taxId.value : null;
  } else {
    if (taxIdsCached.has(customer.id)) {
      return taxIdsCached.get(customer.id);
    }
    const ids = await stripe.customers.listTaxIds(customer.id, { limit: 10 });
    const taxId = ids.data.length > 0 ? ids.data[0].value : null;
    taxIdsCached.set(customer.id, taxId);
    return taxId;
  }
}

const countryCodesEu = [
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
];

async function getAccountingProps(
  customer,
  invoice = null,
  checkoutSession = null
) {
  const props = {
    vat_region: "World",
    customer_account: String(config.accounts.sammel_debitor),
  };

  const address = customer.address || customer.shipping.address;
  const country = address.country;

  let invoiceTax = null;
  if (invoice) {
    invoiceTax = invoice.tax;
  } else if (checkoutSession) {
    invoiceTax = checkoutSession.total_details?.amount_tax;
  }

  let taxExempt;
  if (
    invoice &&
    "customer_tax_exempt" in invoice &&
    !invoice.automatic_tax.enabled
  ) {
    taxExempt = invoice.customer_tax_exempt;
  } else {
    taxExempt = customer.tax_exempt;
  }

  const vatId = await getCustomerTaxId(customer);

  Object.assign(props, {
    country,
    vat_id: vatId,
    tax_exempt: taxExempt,
    invoice_tax: invoiceTax,
    datev_tax_key: "",
  });

  if (country === "DE") {
    if (invoice && invoiceTax === null) {
      console.warn("Warning: no tax in DE invoice", invoice.id);
    }
    if (taxExempt !== "none") {
      console.warn(
        "Warning: DE customer tax status is",
        taxExempt,
        customer.id
      );
    }
    props.revenue_account = String(config.accounts.revenue_german_vat);
    props.datev_tax_key = String(config.accounts.datev_tax_key_germany);
    props.vat_region = "DE";
    return props;
  }

  if (countryCodesEu.includes(country)) {
    props.vat_region = "EU";
  }

  if (
    taxExempt === "reverse" ||
    taxExempt === "exempt" ||
    invoiceTax === null ||
    invoiceTax === 0
  ) {
    if (invoice) {
      if (taxExempt === "exempt") {
        console.warn(
          "Warning: tax exempt customer, treating like 'reverse'",
          customer.id
        );
        props.tax_exempt = "reverse";
      }
      if (taxExempt === "none") {
        console.warn(
          "Warning: taxable customer without tax on invoice, treating like 'reverse'",
          customer.id,
          invoice ? invoice.id || "n/a" : "n/a"
        );
        props.tax_exempt = "reverse";
      }
      if (invoiceTax !== null && invoiceTax !== 0) {
        console.warn(
          "Warning: tax on invoice of reverse charge customer",
          invoice ? invoice.id || "n/a" : "n/a"
        );
      }
      if (countryCodesEu.includes(country) && vatId === null) {
        console.warn(
          "Warning: EU reverse charge customer without VAT ID",
          customer.id
        );
      }
    }

    if (countryCodesEu.includes(country) && vatId !== null) {
      props.revenue_account = String(config.accounts.revenue_reverse_charge_eu);
    } else {
      props.revenue_account = String(
        config.accounts.account_reverse_charge_world
      );
    }

    props.datev_tax_key = String(config.accounts.datev_tax_key_reverse);
    return props;
  } else if (taxExempt === "none") {
    // Unter Bagatellgrenze MOSS
  } else {
    console.warn("Warning: unknown tax status for customer", customer.id);
  }

  props.revenue_account = String(config.accounts.revenue_german_vat);
  return props;
}

function getRevenueAccount(customer, invoice = null, checkoutSession = null) {
  return getAccountingProps(customer, invoice, checkoutSession).then(
    (props) => props.revenue_account
  );
}

function getCustomerAccount(customer, invoice = null, checkoutSession = null) {
  return getAccountingProps(customer, invoice, checkoutSession).then(
    (props) => props.customer_account
  );
}

function getDatevTaxKey(customer, invoice = null, checkoutSession = null) {
  return getAccountingProps(customer, invoice, checkoutSession).then(
    (props) => props.datev_tax_key
  );
}

async function validateCustomers() {
  let customerCount = 0;
  for await (const customer of stripe.customers.list({
    expand: ["data.tax_ids"],
  })) {
    if (!customer.address) {
      console.warn("Warning: customer without address", customer.id);
    }

    if (customer.tax_exempt === "exempt") {
      console.warn("Warning: exempt customer", customer.id);
    }

    await getAccountingProps(customer);

    customerCount++;
  }

  console.log(`Validated ${customerCount} customers`);
}

async function fillAccountNumbers() {
  let highestAccountNumber = null;
  const fillCustomers = [];
  for await (const customer of stripe.customers.list()) {
    if ("accountNumber" in customer.metadata) {
      highestAccountNumber = parseInt(customer.metadata.accountNumber);
      break;
    }
    fillCustomers.push(customer);
  }

  if (highestAccountNumber === null) {
    highestAccountNumber = 10100 - 1;
  }

  console.log(
    `${fillCustomers.length} customers without account number, highest number is ${highestAccountNumber}`
  );

  for (const customer of fillCustomers.reverse()) {
    highestAccountNumber++;
    const metadataNew = {
      accountNumber: String(highestAccountNumber),
    };

    for (const oldKey of [
      "subscribedNetPrice",
      "subscribedProduct",
      "subscribedProductName",
      "subscribedTaxRate",
      "subscribedTotal",
    ]) {
      if (oldKey in customer.metadata) {
        metadataNew[oldKey] = "";
      }
    }

    await stripe.customers.update(customer.id, { metadata: metadataNew });

    console.log(customer.id, highestAccountNumber);
  }
}

async function listAccountNumbers(filePath) {
  const customerIt = stripe.customers.list({ expand: ["data.tax_ids"] });
  if (filePath === null) {
    output.printAccounts(process.stdout, customerIt);
  } else {
    const fs = require("fs");
    const writeStream = fs.createWriteStream(filePath, { encoding: "latin1" });
    await output.printAccounts(writeStream, customerIt);
    writeStream.end();
  }
}

module.exports = {
  retrieveCustomer,
  getCustomerName,
  getCustomerTaxId,
  getAccountingProps,
  getRevenueAccount,
  getCustomerAccount,
  getDatevTaxKey,
  validateCustomers,
  fillAccountNumbers,
  listAccountNumbers,
};
