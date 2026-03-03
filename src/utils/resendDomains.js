const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

exports.createDomain = (name) => resend.domains.create({ name });

exports.getDomain = (id) => resend.domains.get(id);

exports.verifyDomain = (id) => resend.domains.verify(id);

exports.updateDomain = (options) => resend.domains.update(options);

exports.listDomains = () => resend.domains.list();

exports.removeDomain = (id) => resend.domains.remove(id);
