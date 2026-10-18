// Email sending via SMTP (Nodemailer). Works with a Gmail App Password or any SMTP provider.
const nodemailer = require('nodemailer');

const port = Number(process.env.SMTP_PORT || 465);
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port,
  secure: port === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  // Nodemailer's defaults wait minutes; a request that sends mail (register, resend code,
  // invite) gives up within about 30 s instead (the pages wait 45 s).
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 20000,
});

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const peso = (n) => `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function layout(title, body) {
  return `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;border:1px solid #e5e5e5;border-radius:8px">
  <h2 style="margin-top:0">${esc(title)}</h2>${body}
  <p style="color:#888;font-size:12px;margin-top:32px">Bongalink · Computer, laptop and printer parts</p></div>`;
}

const send = (to, subject, html, text) =>
  transporter.sendMail({ from: process.env.MAIL_FROM, to, subject, html, text });

const mail = {
  verificationCode: (to, name, code, ttlMin) =>
    send(
      to,
      'Your Bongalink verification code',
      layout('Verify your email', `<p>Hi ${esc(name)},</p><p>Your verification code is:</p>
        <p style="font-size:32px;letter-spacing:8px;font-weight:bold;margin:16px 0">${code}</p>
        <p>This code expires in ${ttlMin} minutes. If you didn't create a Bongalink account, ignore this email.</p>`),
      `Your Bongalink verification code is ${code}. It expires in ${ttlMin} minutes.`
    ),

  paymentReceived: (to, name, orderId, amount) =>
    send(
      to,
      `Payment received for order #${orderId}`,
      layout('Payment received', `<p>Hi ${esc(name)},</p><p>We received your payment of <b>${peso(amount)}</b>
        for order <b>#${orderId}</b>. We'll email you the tracking details once it ships.</p>`),
      `We received your payment of ${peso(amount)} for order #${orderId}.`
    ),

  // REQ014: send tracking information to the customer
  shipmentBooked: (to, name, orderId, courierLabel, trackingNumber, trackingUrl) =>
    send(
      to,
      `Order #${orderId} has shipped`,
      layout('Your order is on the way', `<p>Hi ${esc(name)},</p><p>Order <b>#${orderId}</b> was handed to
        <b>${esc(courierLabel)}</b>.</p>
        ${trackingNumber ? `<p>Tracking number: <b>${esc(trackingNumber)}</b></p>` : ''}
        ${trackingUrl ? `<p><a href="${esc(trackingUrl)}">Track your package</a></p>` : ''}`),
      `Order #${orderId} shipped via ${courierLabel}. ${trackingNumber ? 'Tracking no: ' + trackingNumber : ''} ${trackingUrl || ''}`
    ),

  // Shop alert when an order is paid (replaces the real-time dashboard push).
  // order = { orderId, amount, courierLabel, shipName, shipPhone, shipAddress, items: [{ name, quantity }] }
  orderPaidAlert: (to, order) =>
    send(
      to,
      `New paid order #${order.orderId} - ${peso(order.amount)}`,
      layout(`Order #${order.orderId} is paid`, `<p>Pack and ship this order:</p>
        <table style="border-collapse:collapse;width:100%">
          ${order.items.map((i) => `<tr><td style="padding:4px 0">${esc(i.name)}</td>
            <td style="padding:4px 0;text-align:right">x ${Number(i.quantity)}</td></tr>`).join('')}
        </table>
        <p><b>Courier:</b> ${esc(order.courierLabel)}</p>
        <p><b>Ship to:</b> ${esc(order.shipName)} (${esc(order.shipPhone)})<br>${esc(order.shipAddress)}</p>
        <p><b>Total paid:</b> ${peso(order.amount)}</p>`),
      [
        `Order #${order.orderId} is paid (${peso(order.amount)}).`,
        ...order.items.map((i) => `- ${i.name} x ${i.quantity}`),
        `Courier: ${order.courierLabel}`,
        `Ship to: ${order.shipName} (${order.shipPhone}), ${order.shipAddress}`,
      ].join('\n')
    ),

  // An admin created this account: verify the email and choose a password (REQ010).
  accountInvite: (to, name, role, link, ttlHours) =>
    send(
      to,
      'Set up your Bongalink account',
      layout('Your Bongalink account is ready', `<p>Hi ${esc(name)},</p>
        <p>The shop created a Bongalink ${role === 'admin' ? '<b>admin</b> ' : ''}account for you.
        Your username is <b>${esc(name)}</b>.</p>
        <p>Open this link to confirm your email and choose your password:</p>
        <p><a href="${esc(link)}" style="display:inline-block;background:#14498c;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Set my password</a></p>
        <p>The link works once and expires in ${ttlHours} hours. If you weren't expecting this, you can ignore this email.</p>`),
      `The shop created a Bongalink account for you (username ${name}). Set your password within ${ttlHours} hours: ${link}`
    ),

  // Forgot password (services/passwordReset.js).
  passwordReset: (to, name, link, ttlMinutes) =>
    send(
      to,
      'Reset your Bongalink password',
      layout('Reset your password', `<p>Hi ${esc(name)},</p>
        <p>Someone asked to reset the password of your Bongalink account (username <b>${esc(name)}</b>).
        If it was you, open this link to choose a new password:</p>
        <p><a href="${esc(link)}" style="display:inline-block;background:#14498c;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Choose a new password</a></p>
        <p>The link works once and expires in ${ttlMinutes} minutes. If you didn't ask for this, ignore this email:
        your password stays the same.</p>`),
      `Reset your Bongalink password (username ${name}) within ${ttlMinutes} minutes: ${link}\nIf you didn't ask for this, ignore this email.`
    ),

  passwordChanged: (to, name) =>
    send(
      to,
      'Your Bongalink password was changed',
      layout('Your password was changed', `<p>Hi ${esc(name)},</p>
        <p>The password of your Bongalink account was just changed, and every device that was logged in has been logged out.</p>
        <p>If you didn't do this, contact the shop right away.</p>`),
      `The password of your Bongalink account (${name}) was just changed and all devices were logged out. If this wasn't you, contact the shop right away.`
    ),

  // A suspended account asked for a reset: no link, just why.
  resetBlockedSuspended: (to, name) =>
    send(
      to,
      'About your Bongalink password reset',
      layout('Your account is suspended', `<p>Hi ${esc(name)},</p>
        <p>We got a request to reset your Bongalink password, but your account is suspended, so the password can't be reset.
        Contact the shop if you think this is a mistake.</p>`),
      `We got a request to reset your Bongalink password, but your account is suspended. Contact the shop if you think this is a mistake.`
    ),

  delivered: (to, name, orderId) =>
    send(
      to,
      `Order #${orderId} delivered`,
      layout('Delivered', `<p>Hi ${esc(name)},</p><p>Order <b>#${orderId}</b> was marked as delivered. Thank you for buying from Bongalink!</p>`),
      `Order #${orderId} was delivered. Thank you for buying from Bongalink!`
    ),
};

module.exports = { mail, transporter };
