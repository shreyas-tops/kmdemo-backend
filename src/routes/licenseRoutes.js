const express = require("express");
const router = express.Router();
const { createLicense } = require("../controllers/licenseController");

router.post("/create", createLicense);

module.exports = router;