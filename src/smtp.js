// A minimal SMTP client.
//
// Why hand-rolled: this project is deliberately ZERO-DEPENDENCY (see the Dockerfile and package.json),
// and the daily email was silently broken because `nodemailer` was imported but never installed in the
// image. Speaking SMTP ourselves is ~110 lines and keeps the "no install step" promise.
//
// Supports: implicit TLS (465), STARTTLS upgrade (587), AUTH PLAIN / AUTH LOGIN, one recipient.
// Deliberately not supported: attachments, HTML alternatives, multiple recipients, pipelining.
import net from 'node:net';
import tls from 'node:tls';

const CRLF = '\r\n';
const b64 = (s) => Buffer.from(String(s == null ? '' : s), 'utf8').toString('base64');

// Wrap a socket as a line-oriented SMTP conversation.
function conversation(sock, timeoutMs) {
  let buf = '';
  const queue = [];                 // lines that arrived before someone asked for them
  let wait = null;
  const fail = (e) => { const w = wait; wait = null; if (w) w.rej(e); };
  sock.setEncoding('utf8');
  sock.setTimeout(timeoutMs, () => fail(new Error('smtp timeout')));
  sock.on('error', fail);
  sock.on('close', () => fail(new Error('smtp connection closed')));
  sock.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      const w = wait;
      if (w) { wait = null; w.res(line); } else queue.push(line);   // ← queue, don't drop
    }
  });
  const nextLine = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((res, rej) => { wait = { res, rej }; }));
  return {
    write: (s) => sock.write(s),
    // A reply is multi-line while its 4th character is '-': "250-PIPELINING" … "250 SIZE 1".
    async reply() {
      for (;;) {
        const line = await nextLine();
        if (line.length >= 4 && line[3] === '-') continue;
        return { code: Number(line.slice(0, 3)), text: line.slice(4) };
      }
    },
    async cmd(line, expect) {
      sock.write(line + CRLF);
      const r = await this.reply();
      if (!expect.includes(r.code)) throw new Error(`smtp ${String(line).split(' ')[0]} -> ${r.code} ${r.text}`);
      return r;
    },
    async expect(code) {
      const r = await this.reply();
      if (r.code !== code) throw new Error(`smtp expected ${code}, got ${r.code} ${r.text}`);
      return r;
    },
  };
}

function messageHeaders({ from, to, subject, date = new Date() }) {
  const id = `<${Date.now()}.${Math.random().toString(36).slice(2)}@watchtower>`;
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${id}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
}

/**
 * Send a plain-text mail. Resolves { accepted: true } when the server accepts the message.
 * Throws on any connection/protocol error, so callers can surface it to the operator.
 */
export async function sendMail({ host = 'smtp.gmail.com', port = 465, secure = true, user, pass, from, to, subject, text, timeoutMs = 30000, rejectUnauthorized = true }) {
  if (!host || !from || !to) throw new Error('smtp: host, from and to are required');
  let sock = secure
    ? tls.connect({ host, port, servername: host, rejectUnauthorized })
    : net.connect({ host, port });
  await new Promise((res, rej) => {
    sock.setTimeout(timeoutMs, () => rej(new Error('smtp connect timeout')));
    sock.once(secure ? 'secureConnect' : 'connect', res);
    sock.once('error', rej);
  });

  try {
  let io = conversation(sock, timeoutMs);
  await io.expect(220);                                   // server greeting

  let caps = (await io.cmd('EHLO watchtower', [250])).text;
  let encrypted = secure;

  // Only upgrade when the server actually advertises STARTTLS (a plain server must keep working).
  if (!secure && /STARTTLS/i.test(caps)) {
    await io.cmd('STARTTLS', [220]);
    sock = tls.connect({ socket: sock, servername: host, rejectUnauthorized });
    await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
    io = conversation(sock, timeoutMs);
    caps = (await io.cmd('EHLO watchtower', [250])).text;
    encrypted = true;
  }

  if (user && pass) {
    if (!encrypted) throw new Error('smtp: refusing to send credentials over an unencrypted connection');
    if (/AUTH[^\n]*PLAIN/i.test(caps)) await io.cmd(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, [235]);
    else if (/AUTH[^\n]*LOGIN/i.test(caps)) {
      await io.cmd('AUTH LOGIN', [334]);
      await io.cmd(b64(user), [334]);
      await io.cmd(b64(pass), [235]);
    } else throw new Error('smtp: server offers no supported AUTH mechanism');
  }

  await io.cmd(`MAIL FROM:<${from}>`, [250]);
  await io.cmd(`RCPT TO:<${to}>`, [250, 251]);
  await io.cmd('DATA', [354]);
  const body = Buffer.from(String(text == null ? '' : text), 'utf8').toString('base64').replace(/(.{76})/g, `$1${CRLF}`);
  io.write(messageHeaders({ from, to, subject }).join(CRLF) + CRLF + CRLF + body + CRLF + '.' + CRLF);
  await io.expect(250);
  io.write('QUIT' + CRLF);
  sock.end();
  return { accepted: true };
  } catch (e) {
    try { sock.destroy(); } catch {}                       // never leave a half-open SMTP socket
    throw e;
  }
}
