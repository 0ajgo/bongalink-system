// Stand-in for services/mailer: records calls, sends nothing.
// Use with: jest.mock("../services/mailer", () => require("./mailerMock")());
module.exports = () => ({
  mail: {
    verificationCode: jest.fn().mockResolvedValue(),
    paymentReceived: jest.fn().mockResolvedValue(),
    shipmentBooked: jest.fn().mockResolvedValue(),
    orderPaidAlert: jest.fn().mockResolvedValue(),
    delivered: jest.fn().mockResolvedValue()
  },
  transporter: {}
});
