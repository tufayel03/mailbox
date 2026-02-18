const dns = require("dns").promises;

function generateDnsRecords(domain, mailHostname, dkimData, mailIpv4, mailIpv6) {
  const records = [];

  if (mailIpv4) {
    records.push({ type: "A", name: "mail", value: mailIpv4 });
  }

  if (mailIpv6) {
    records.push({ type: "AAAA", name: "mail", value: mailIpv6 });
  }

  records.push({ type: "MX", name: "@", value: mailHostname, priority: 10 });
  records.push({ type: "TXT", name: "@", value: "v=spf1 mx -all" });

  if (dkimData && dkimData.dkim_selector && dkimData.dkim_txt) {
    records.push({
      type: "TXT",
      name: `${dkimData.dkim_selector}._domainkey`,
      value: dkimData.dkim_txt
    });
  }

  records.push({
    type: "TXT",
    name: "_dmarc",
    value: `v=DMARC1; p=quarantine; adkim=s; aspf=s; rua=mailto:dmarc@${domain}; fo=1`
  });

  records.push({ type: "CNAME", name: "autodiscover", value: mailHostname });
  records.push({ type: "CNAME", name: "autoconfig", value: mailHostname });

  return records;
}

function fqdnForRecord(name, domain) {
  if (name === "@") {
    return domain;
  }

  if (name.endsWith(`.${domain}`)) {
    return name;
  }

  return `${name}.${domain}`;
}

function normalizeTxtValues(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values.map((entry) => {
    if (Array.isArray(entry)) {
      return entry.join("");
    }
    return String(entry);
  });
}

async function lookupRecord(record, domain) {
  const fqdn = fqdnForRecord(record.name, domain);

  try {
    switch (record.type) {
      case "A": {
        const values = await dns.resolve4(fqdn);
        return { ok: values.includes(record.value), observed: values };
      }
      case "AAAA": {
        const values = await dns.resolve6(fqdn);
        return { ok: values.includes(record.value), observed: values };
      }
      case "MX": {
        const values = await dns.resolveMx(fqdn);
        const ok = values.some(
          (mx) => mx.exchange.replace(/\.$/, "") === record.value.replace(/\.$/, "") && Number(mx.priority) === Number(record.priority)
        );
        return {
          ok,
          observed: values.map((mx) => `${mx.priority} ${mx.exchange.replace(/\.$/, "")}`)
        };
      }
      case "TXT": {
        const values = normalizeTxtValues(await dns.resolveTxt(fqdn));
        const normalizedExpected = record.value.replace(/\s+/g, " ").trim();
        const ok = values.some((v) => v.replace(/\s+/g, " ").trim().includes(normalizedExpected));
        return { ok, observed: values };
      }
      case "CNAME": {
        const values = await dns.resolveCname(fqdn);
        const ok = values.some((value) => value.replace(/\.$/, "") === record.value.replace(/\.$/, ""));
        return { ok, observed: values.map((value) => value.replace(/\.$/, "")) };
      }
      default:
        return { ok: false, observed: [`Unsupported record type: ${record.type}`] };
    }
  } catch (err) {
    return { ok: false, observed: [`Lookup failed: ${err.code || err.message}`] };
  }
}

async function checkDnsRecords(domain, records) {
  const checks = [];

  for (const record of records) {
    // eslint-disable-next-line no-await-in-loop
    const result = await lookupRecord(record, domain);
    checks.push({
      ...record,
      pass: result.ok,
      observed: result.observed
    });
  }

  return {
    domain,
    allPassed: checks.every((item) => item.pass),
    checkedAt: new Date().toISOString(),
    records: checks
  };
}

module.exports = {
  generateDnsRecords,
  checkDnsRecords
};