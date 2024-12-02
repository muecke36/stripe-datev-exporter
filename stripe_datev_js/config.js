import fs from "fs";
import toml from "toml";
import { DateTime } from "luxon";

const config = toml.parse(fs.readFileSync("config.toml", "utf-8"));

const company = config.company;
const accountingTz = DateTime.local().setZone(company.timezone);

const datev = config.datev;
const accounts = config.accounts;
