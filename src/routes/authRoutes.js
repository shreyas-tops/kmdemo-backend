const express = require("express");
const router = express.Router();
const {
  signup,
  verifyOtp,
  signIn,
  resendOtp,
  forgotPassword,
  verifyForgotOtp,
  resetPassword,
  resendForgotOtp,
} = require("../controllers/authController");

router.post("/signup", signup);
router.post("/verify-otp", verifyOtp);
router.post("/signin", signIn);
router.post("/resend-otp", resendOtp);
router.post("/forgot-password", forgotPassword);
router.post("/verify-forgot-otp", verifyForgotOtp);
router.post("/resend-forgot-otp", resendForgotOtp);
router.post("/reset-password", resetPassword);

module.exports = router;
