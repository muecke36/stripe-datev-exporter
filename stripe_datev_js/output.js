import { format } from "date-fns";
import * as config from "./config";
import * as customer from "./customer";
import fs from "fs";
import path from "path";

const fields = [
  "Umsatz (ohne Soll/Haben-Kz)",
  "Soll/Haben-Kennzeichen",
  "WKZ Umsatz",
  "Kurs",
  "Basis-Umsatz",
  "WKZ Basis-Umsatz",
  "Konto",
  "Gegenkonto (ohne BU-Schlüssel)",
  "BU-Schlüssel",
  "Belegdatum",
  "Belegfeld 1",
  "Belegfeld 2",
  "Skonto",
  "Buchungstext",
  "Postensperre",
  "Diverse Adressnummer",
  "Geschäftspartnerbank",
  "Sachverhalt",
  "Zinssperre",
  "Beleglink",
  "Beleginfo - Art 1",
  "Beleginfo - Inhalt 1",
  "Beleginfo - Art 2",
  "Beleginfo - Inhalt 2",
  "Beleginfo - Art 3",
  "Beleginfo - Inhalt 3",
  "Beleginfo - Art 4",
  "Beleginfo - Inhalt 4",
  "Beleginfo - Art 5",
  "Beleginfo - Inhalt 5",
  "Beleginfo - Art 6",
  "Beleginfo - Inhalt 6",
  "Beleginfo - Art 7",
  "Beleginfo - Inhalt 7",
  "Beleginfo - Art 8",
  "Beleginfo - Inhalt 8",
  "KOST1 - Kostenstelle",
  "KOST2 - Kostenstelle",
  "Kost-Menge",
  "EU-Land u. UStID",
  "EU-Steuersatz",
  "Abw. Versteuerungsart",
  "Sachverhalt L+L",
  "Funktionsergänzung L+L",
  "BU 49 Hauptfunktionstyp",
  "BU 49 Hauptfunktionsnummer",
  "BU 49 Funktionsergänzung",
  "Zusatzinformation - Art 1",
  "Zusatzinformation- Inhalt 1",
  "Zusatzinformation - Art 2",
  "Zusatzinformation- Inhalt 2",
  "Zusatzinformation - Art 3",
  "Zusatzinformation- Inhalt 3",
  "Zusatzinformation - Art 4",
  "Zusatzinformation- Inhalt 4",
  "Zusatzinformation - Art 5",
  "Zusatzinformation- Inhalt 5",
  "Zusatzinformation - Art 6",
  "Zusatzinformation- Inhalt 6",
  "Zusatzinformation - Art 7",
  "Zusatzinformation- Inhalt 7",
  "Zusatzinformation - Art 8",
  "Zusatzinformation- Inhalt 8",
  "Zusatzinformation - Art 9",
  "Zusatzinformation- Inhalt 9",
  "Zusatzinformation - Art 10",
  "Zusatzinformation- Inhalt 10",
  "Zusatzinformation - Art 11",
  "Zusatzinformation- Inhalt 11",
  "Zusatzinformation - Art 12",
  "Zusatzinformation- Inhalt 12",
  "Zusatzinformation - Art 13",
  "Zusatzinformation- Inhalt 13",
  "Zusatzinformation - Art 14",
  "Zusatzinformation- Inhalt 14",
  "Zusatzinformation - Art 15",
  "Zusatzinformation- Inhalt 15",
  "Zusatzinformation - Art 16",
  "Zusatzinformation- Inhalt 16",
  "Zusatzinformation - Art 17",
  "Zusatzinformation- Inhalt 17",
  "Zusatzinformation - Art 18",
  "Zusatzinformation- Inhalt 18",
  "Zusatzinformation - Art 19",
  "Zusatzinformation- Inhalt 19",
  "Zusatzinformation - Art 20",
  "Zusatzinformation- Inhalt 20",
  "Stück",
  "Gewicht",
  "Zahlweise",
  "Forderungsart",
  "Veranlagungsjahr",
  "Zugeordnete Fälligkeit",
  "Skontotyp",
  "Auftragsnummer",
  "Buchungstyp",
  "USt-Schlüssel (Anzahlungen)",
  "EU-Land (Anzahlungen)",
  "Sachverhalt L+L (Anzahlungen)",
  "EU-Steuersatz (Anzahlungen)",
  "Erlöskonto (Anzahlungen)",
  "Herkunft-Kz",
  "Buchungs GUID",
  "KOST-Datum",
  "SEPA-Mandatsreferenz",
  "Skontosperre",
  "Gesellschaftername",
  "Beteiligtennummer",
  "Identifikationsnummer",
  "Zeichnernummer",
  "Postensperre bis",
  "Bezeichnung SoBil-Sachverhalt",
  "Kennzeichen SoBil-Buchung",
  "Festschreibung",
  "Leistungsdatum",
  "Datum Zuord. Steuerperiode",
  "Fälligkeit",
  "Generalumkehr (GU)",
  "Steuersatz",
  "Land",
  "",
];

function filterRecords(records, fromTime = null, toTime = null) {
  return records.filter(
    (r) =>
      (fromTime === null || r.date >= fromTime) &&
      (toTime === null || r.date <= toTime)
  );
}

function writeRecords(
  fileName,
  records,
  fromTime = null,
  toTime = null,
  bezeichung = null
) {
  if (records.length === 0) {
    return;
  }
  const fp = fs.createWriteStream(fileName, { encoding: "latin1", flags: "w" });
  printRecords(fp, records, fromTime, toTime, bezeichung);
  console.log(
    `Wrote ${String(records.length).padStart(
      4,
      " "
    )} acc. records to ${path.relative(process.cwd(), fp.path)}`
  );
}

function printRecords(
  textFileHandle,
  records,
  fromTime = null,
  toTime = null,
  bezeichung = null
) {
  if (fromTime !== null || toTime !== null) {
    records = filterRecords(records, fromTime, toTime);
  }

  const minTime = fromTime || Math.min(...records.map((r) => r.date));
  const maxTime = toTime || Math.max(...records.map((r) => r.date));
  const years = new Set(records.map((r) => format(r.date, "yyyy")));
  if (years.size > 1) {
    throw new Error(
      `May not print records from multiple years: ${Array.from(years).join(
        ", "
      )}`
    );
  }

  const header = [
    '"EXTF"', // DATEV-Format (DTVF - von DATEV erzeugt, EXTF Fremdprogramm)
    "700", // Version des DATEV-Formats (141 bedeutet 1.41)
    "21", // Datenkategorie (21 = Buchungsstapel, 67 = Buchungstextkonstanten, 16 = Debitoren/Kreditoren, 20 = Kontenbeschriftungen usw.)
    "Buchungsstapel",
    "5", // Formatversion (bezogen auf Formatname)
    format(new Date(), "yyyyMMddHHmmss"), // erzeugt am
    "", // importiert am
    "BH", // Herkunft
    "", // exportiert von
    "", // importiert von
    String(config.datev.berater_nr), // Beraternummer
    String(config.datev.mandenten_nr), // Mandantennummer
    format(minTime, "yyyy") + "0101", // Wirtschaftsjahresbeginn
    "4", // Sachkontenlänge
    format(minTime, "yyyyMMdd"), // Datum Beginn Buchungsstapel
    format(maxTime, "yyyyMMdd"), // Datum Ende Buchungsstapel
    bezeichung ? `"${bezeichung}"` : "", // Bezeichnung (Vorlaufname, z. B. Buchungsstapel)
    "", // Diktatkürzel
    "1", // Buchungstyp (bei Buchungsstapel = 1)
    "0", // Rechnungslegungszweck
    "0", // Festschreibung
  ];
  textFileHandle.write(header.join(";") + "\n");

  textFileHandle.write(fields.join(";") + "\n");

  for (const record of records) {
    record.Belegdatum = formatDateDatev(record.date);
    record.Buchungstext = `"${record.Buchungstext.slice(0, 60)}"`;

    const recordValues = fields.map((f) => record[f] || "");
    textFileHandle.write(recordValues.join(";") + "\n");
  }
}

function formatDateDatev(date) {
  return format(date, "ddMM", { timeZone: config.accounting_tz });
}

function formatDateHuman(date) {
  return format(date, "dd.MM.yyyy", { timeZone: config.accounting_tz });
}

function formatDecimal(d) {
  return d.toFixed(2).replace(".", ",");
}

const fields_accounts = [
  "Konto",
  "Name (Adressattyp Unternehmen)",
  "Unternehmensgegenstand",
  "Name (Adressattyp natürl. Person)",
  "Vorname (Adressattyp natürl. Person)",
  "Name (Adressattyp keine Angabe)",
  "Adressattyp",
  "Kurzbezeichnung",
  "EU-Land",
  "EU-UStID",
  "Anrede",
  "Titel/Akad. Grad",
  "Adelstitel",
  "Namensvorsatz",
  "Adressart",
  "Straße",
  "Postfach",
  "Postleitzahl",
  "Ort",
  "Land",
  "Versandzusatz",
  "Adresszusatz",
  "Abweichende Anrede",
  "Abw. Zustellbezeichnung 1",
  "Abw. Zustellbezeichnung 2",
  "Kennz. Korrespondenzadresse",
  "Adresse Gültig von",
  "Adresse Gültig bis",
  "Telefon",
  "Bemerkung (Telefon)",
  "Telefon GL",
  "Bemerkung (Telefon GL)",
  "E-Mail",
  "Bemerkung (E-Mail)",
  "Internet",
  "Bemerkung (Internet)",
  "Fax",
  "Bemerkung (Fax)",
  "Sonstige",
  "Bemerkung (Sonstige)",
  "Bankleitzahl 1",
  "Bankbezeichnung 1",
  "Bank-Kontonummer 1",
  "Länderkennzeichen 1",
  "IBAN-Nr. 1",
  "Leerfeld",
  "SWIFT-Code 1",
  "Abw. Kontoinhaber 1",
  "Kennz. Hauptbankverb. 1",
  "Bankverb 1 Gültig von",
  "Bankverb 1 Gültig bis",
  "Bankleitzahl 2",
  "Bankbezeichnung 2",
  "Bank-Kontonummer 2",
  "Länderkennzeichen 2",
  "IBAN-Nr. 2",
  "Leerfeld",
  "SWIFT-Code 2",
  "Abw. Kontoinhaber 2",
  "Kennz. Hauptbankverb. 2",
  "Bankverb 2 Gültig von",
  "Bankverb 2 Gültig bis",
  "Bankleitzahl 3",
  "Bankbezeichnung 3",
  "Bank-Kontonummer 3",
  "Länderkennzeichen 3",
  "IBAN-Nr. 3",
  "Leerfeld",
  "SWIFT-Code 3",
  "Abw. Kontoinhaber 3",
  "Kennz. Hauptbankverb. 3",
  "Bankverb 3 Gültig von",
  "Bankverb 3 Gültig bis",
  "Bankleitzahl 4",
  "Bankbezeichnung 4",
  "Bank-Kontonummer 4",
  "Länderkennzeichen 4",
  "IBAN-Nr. 4",
  "Leerfeld",
  "SWIFT-Code 4",
  "Abw. Kontoinhaber 4",
  "Kennz. Hauptbankverb. 4",
  "Bankverb 4 Gültig von",
  "Bankverb 4 Gültig bis",
  "Bankleitzahl 5",
  "Bankbezeichnung 5",
  "Bank-Kontonummer 5",
  "Länderkennzeichen 5",
  "IBAN-Nr. 5",
  "Leerfeld",
  "SWIFT-Code 5",
  "Abw. Kontoinhaber 5",
  "Kennz. Hauptbankverb. 5",
  "Bankverb 5 Gültig von",
  "Bankverb 5 Gültig bis",
  "Leerfeld",
  "Briefanrede",
  "Grußformel",
  "Kunden-/Lief.-Nr.",
  "Steuernummer",
  "Sprache",
  "Ansprechpartner",
  "Vertreter",
  "Sachbearbeiter",
  "Diverse-Konto",
  "Ausgabeziel",
  "Währungssteuerung",
  "Kreditlimit (Debitor)",
  "Zahlungsbedingung",
  "Fälligkeit in Tagen (Debitor)",
  "Skonto in Prozent (Debitor)",
  "Kreditoren-Ziel 1 Tg.",
  "Kreditoren-Skonto 1 %",
  "Kreditoren-Ziel 2 Tg.",
  "Kreditoren-Skonto 2 %",
  "Kreditoren-Ziel 3 Brutto Tg.",
  "Kreditoren-Ziel 4 Tg.",
  "Kreditoren-Skonto 4 %",
  "Kreditoren-Ziel 5 Tg.",
  "Kreditoren-Skonto 5 %",
  "Mahnung",
  "Kontoauszug",
  "Mahntext 1",
  "Mahntext 2",
  "Mahntext 3",
  "Kontoauszugstext",
  "Mahnlimit Betrag",
  "Mahnlimit %",
  "Zinsberechnung",
  "Mahnzinssatz 1",
  "Mahnzinssatz 2",
  "Mahnzinssatz 3",
  "Lastschrift",
  "Leerfeld",
  "Mandantenbank",
  "Zahlungsträger",
  "Indiv. Feld 1",
  "Indiv. Feld 2",
  "Indiv. Feld 3",
  "Indiv. Feld 4",
  "Indiv. Feld 5",
  "Indiv. Feld 6",
  "Indiv. Feld 7",
  "Indiv. Feld 8",
  "Indiv. Feld 9",
  "Indiv. Feld 10",
  "Indiv. Feld 11",
  "Indiv. Feld 12",
  "Indiv. Feld 13",
  "Indiv. Feld 14",
  "Indiv. Feld 15",
  "Abweichende Anrede (Rechnungsadresse)",
  "Adressart (Rechnungsadresse)",
  "Straße (Rechnungsadresse)",
  "Postfach (Rechnungsadresse)",
  "Postleitzahl (Rechnungsadresse)",
  "Ort (Rechnungsadresse)",
  "Land (Rechnungsadresse)",
  "Versandzusatz (Rechnungsadresse)",
  "Adresszusatz (Rechnungsadresse)",
  "Abw. Zustellbezeichnung 1 (Rechnungsadresse)",
  "Abw. Zustellbezeichnung 2 (Rechnungsadresse)",
  "Adresse Gültig von (Rechnungsadresse)",
  "Adresse Gültig bis (Rechnungsadresse)",
  "Bankleitzahl 6",
  "Bankbezeichnung 6",
  "Bank-Kontonummer 6",
  "Länderkennzeichen 6",
  "IBAN-Nr. 6",
  "Leerfeld",
  "SWIFT-Code 6",
  "Abw. Kontoinhaber 6",
  "Kennz. Hauptbankverb. 6",
  "Bankverb 6 Gültig von",
  "Bankverb 6 Gültig bis",
  "Bankleitzahl 7",
  "Bankbezeichnung 7",
  "Bank-Kontonummer 7",
  "Länderkennzeichen 7",
  "IBAN-Nr. 7",
  "Leerfeld",
  "SWIFT-Code 7",
  "Abw. Kontoinhaber 7",
  "Kennz. Hauptbankverb. 7",
  "Bankverb 7 Gültig von",
  "Bankverb 7 Gültig bis",
  "Bankleitzahl 8",
  "Bankbezeichnung 8",
  "Bank-Kontonummer 8",
  "Länderkennzeichen 8",
  "IBAN-Nr. 8",
  "Leerfeld",
  "SWIFT-Code 8",
  "Abw. Kontoinhaber 8",
  "Kennz. Hauptbankverb. 8",
  "Bankverb 8 Gültig von",
  "Bankverb 8 Gültig bis",
  "Bankleitzahl 9",
  "Bankbezeichnung 9",
  "Bank-Kontonummer 9",
  "Länderkennzeichen 9",
  "IBAN-Nr. 9",
  "Leerfeld",
  "SWIFT-Code 9",
  "Abw. Kontoinhaber 9",
  "Kennz. Hauptbankverb. 9",
  "Bankverb 9 Gültig von",
  "Bankverb 9 Gültig bis",
  "Bankleitzahl 10",
  "Bankbezeichnung 10",
  "Bank-Kontonummer 10",
  "Länderkennzeichen 10",
  "IBAN-Nr. 10",
  "Leerfeld",
  "SWIFT-Code 10",
  "Abw. Kontoinhaber 10",
  "Kennz. Hauptbankverb. 10",
  "Bankverb 10 Gültig von",
  "Bankverb 10 Gültig bis",
  "Nummer Fremdsystem",
  "Insolvent",
  "SEPA-Mandatsreferenz 1",
  "SEPA-Mandatsreferenz 2",
  "SEPA-Mandatsreferenz 3",
  "SEPA-Mandatsreferenz 4",
  "SEPA-Mandatsreferenz 5",
  "SEPA-Mandatsreferenz 6",
  "SEPA-Mandatsreferenz 7",
  "SEPA-Mandatsreferenz 8",
  "SEPA-Mandatsreferenz 9",
  "SEPA-Mandatsreferenz 10",
  "Verknüpftes OPOS-Konto",
  "Mahnsperre bis",
  "Lastschriftsperre bis",
  "Zahlungssperre bis",
  "Gebührenberechnung",
  "Mahngebühr 1",
  "Mahngebühr 2",
  "Mahngebühr 3",
  "Pauschalenberechnung",
  "Verzugspauschale 1",
  "Verzugspauschale 2",
  "Verzugspauschale 3",
  "Alternativer Suchname",
  "Status",
  "Anschrift manuell geändert (Korrespondenzadresse)",
  "Anschrift individuell (Korrespondenzadresse)",
  "Anschrift manuell geändert (Rechnungsadresse)",
  "Anschrift individuell (Rechnungsadresse)",
  "Fristberechnung bei Debitor",
  "Mahnfrist 1",
  "Mahnfrist 2",
  "Mahnfrist 3",
  "Letzte Frist",
];

function printAccounts(textFileHandle, customers) {
  const header = [
    '"EXTF"', // DATEV-Format (DTVF - von DATEV erzeugt, EXTF Fremdprogramm)
    "700", // Version des DATEV-Formats (141 bedeutet 1.41)
    "16", // Datenkategorie (21 = Buchungsstapel, 67 = Buchungstextkonstanten, 16 = Debitoren/Kreditoren, 20 = Kontenbeschriftungen usw.)
    "Debitoren/Kreditoren",
    "5", // Formatversion (bezogen auf Formatname)
    format(new Date(), "yyyyMMddHHmmss"), // erzeugt am
    "", // importiert am
    "BH", // Herkunft
    "", // exportiert von
    "", // importiert von
    String(config.datev.berater_nr), // Beraternummer
    String(config.datev.mandenten_nr), // Mandantennummer
    format(new Date(), "yyyy") + "0101", // Wirtschaftsjahresbeginn
    "4", // Sachkontenlänge
    "", // Datum Beginn Buchungsstapel
    "", // Datum Ende Buchungsstapel
    "", // Bezeichnung (Vorlaufname, z. B. Buchungsstapel)
    "", // Diktatkürzel
    "0", // Buchungstyp (bei Buchungsstapel = 1)
    "0", // Rechnungslegungszweck
    "0", // Festschreibung
  ];
  textFileHandle.write(header.join(";") + "\n");

  textFileHandle.write(fields_accounts.join(";") + "\n");

  for (const cus of customers) {
    const acc_props = customer.getAccountingProps(cus);
    const vat_id = acc_props.vat_id;

    const record = {
      Konto: acc_props.customer_account,
      "Name (Adressattyp Unternehmen)": customer.getCustomerName(cus),
      Adressattyp: "2",
      "EU-Land": vat_id ? vat_id.slice(0, 2) : "",
      "EU-UStID": vat_id ? vat_id.slice(2) : "",
      Straße: cus.address.line1 || "",
      Adresszusatz: cus.address.line2 || "",
      Postleitzahl: cus.address.postal_code || "",
      Ort: cus.address.city || "",
      Land: cus.address.country || "",
      "E-Mail": cus.email || "",
    };

    const recordValues = fields_accounts.map((f) => record[f] || "");
    textFileHandle.write(recordValues.join(";") + "\n");
  }
}
