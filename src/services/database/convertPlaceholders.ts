export function convertPlaceholders(sql: string): string {
  let out = '';
  let i = 0;
  let nextParam = 1;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i];
    const next = i + 1 < len ? sql[i + 1] : '';

    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      if (end === -1) {
        out += sql.slice(i);
        return out;
      }
      out += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) {
        out += sql.slice(i);
        return out;
      }
      out += sql.slice(i, end + 2);
      i = end + 2;
      continue;
    }

    if (ch === "'") {
      out += ch;
      i++;
      while (i < len) {
        const c = sql[i];
        if (c === "'") {
          if (i + 1 < len && sql[i + 1] === "'") {
            out += "''";
            i += 2;
            continue;
          }
          out += c;
          i++;
          break;
        }
        out += c;
        i++;
      }
      continue;
    }

    if (ch === '"') {
      out += ch;
      i++;
      while (i < len) {
        const c = sql[i];
        if (c === '"') {
          if (i + 1 < len && sql[i + 1] === '"') {
            out += '""';
            i += 2;
            continue;
          }
          out += c;
          i++;
          break;
        }
        out += c;
        i++;
      }
      continue;
    }

    if (ch === '$') {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        out += tag;
        i += tag.length;
        const closeIdx = sql.indexOf(tag, i);
        if (closeIdx === -1) {
          out += sql.slice(i);
          return out;
        }
        out += sql.slice(i, closeIdx + tag.length);
        i = closeIdx + tag.length;
        continue;
      }
    }

    if (ch === '?') {
      out += `$${nextParam}`;
      nextParam++;
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}
