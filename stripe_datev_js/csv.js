import xlsxwriter from "xlsxwriter";

function escapeCsvField(fieldValue, sep = ";") {
  if (fieldValue === null) {
    fieldValue = "";
  }
  fieldValue = fieldValue
    .replace(/\r\n/g, " ")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(new RegExp(sep, "g"), ":")
    .replace(/\./g, ",");
  return fieldValue;
}

function linesToCsv(linesRows, sep = ";", nl = "\n") {
  return (
    "sep=;\n" +
    linesRows
      .map((l) => l.map((f) => escapeCsvField(f, sep)).join(sep))
      .join(nl)
  );
}
