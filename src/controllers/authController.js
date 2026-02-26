const prisma = require("../config/prisma");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { successResponse, errorResponse } = require("../utils/response");
const { sendOtpEmail } = require("../utils/email");

const validatePassword = (password) => {
  const regex = /^(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&]).{8,}$/;
  return regex.test(password);
};

exports.signup = async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      license_code,
      device_type,
      fcm_token,
      phone_number,
    } = req.body;

    if (
      !name ||
      !email ||
      !password ||
      !license_code ||
      device_type === undefined
    ) {
      return errorResponse(res, "Required fields missing", 400);
    }

    if (!validatePassword(password)) {
      return errorResponse(
        res,
        "Password must be 8 characters, include 1 uppercase, 1 number and 1 special character",
        400,
      );
    }

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return errorResponse(res, "Email already registered", 400);
    }

    const license = await prisma.licenseCode.findUnique({
      where: { code: license_code },
    });

    if (!license) {
      return errorResponse(res, "Invalid license code", 400);
    }

    if (license.isUsed) {
      return errorResponse(res, "License already used", 400);
    }

    if (!license.isActive) {
      return errorResponse(res, "License is inactive", 400);
    }

    if (new Date() > license.subscriptionEnd) {
      return errorResponse(res, "License subscription expired", 400);
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const business = await prisma.business.create({
      data: {
        name: license.businessName,
      },
    });

    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash: hashedPassword,
        phoneNumber: phone_number || null,
        businessId: business.id,
      },
    });

    await prisma.licenseCode.update({
      where: { code: license_code },
      data: {
        isUsed: true,
        usedByUserId: user.id,
        usedAt: new Date(),
      },
    });

    // Remove old OTPs
    await prisma.otpCode.deleteMany({
      where: { email, type: "signup" },
    });

    const otp = Math.floor(100000 + 900000 * Math.random()).toString();

    await prisma.otpCode.create({
      data: {
        email,
        otp,
        type: "signup",
        expiresAt: new Date(Date.now() + 60 * 1000),
      },
    });

    await sendOtpEmail(email, otp, "signup");

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, businessId: business.id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );

    const formattedUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      contact: user.phoneNumber,
      profile_pic: null,
      status: user.isVerified ? 1 : 0,
      user_type: 1, // owner
      subscription_type: license.purchasePlan,
      email_verified_at: user.isVerified ? user.updatedAt : null,
      device_type,
      fcm_token: fcm_token || null,
      created_at: user.createdAt,
      updated_at: user.updatedAt,
      deleted_at: null,
    };

    return res.status(200).json({
      success: true,
      message: "User registered successfully.",
      data: {
        token,
        user: formattedUser,
      },
    });
  } catch (error) {
    console.error("Signup error:", error.message);
    return errorResponse(res, "Server error", 500);
  }
};

exports.verifyOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return errorResponse(res, "Email and OTP are required", 400);
    }

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      return errorResponse(res, "User not found", 404);
    }

    const existingOtp = await prisma.otpCode.findFirst({
      where: {
        email,
        type: "signup",
        isUsed: false,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (!existingOtp) {
      return errorResponse(res, "Invalid OTP", 400);
    }

    if (existingOtp.attempts >= 5) {
      return errorResponse(res, "Maximum OTP attempts exceeded", 400);
    }

    if (new Date() > existingOtp.expiresAt) {
      return errorResponse(res, "OTP expired", 400);
    }

    if (existingOtp.otp !== otp) {
      await prisma.otpCode.update({
        where: { id: existingOtp.id },
        data: { attempts: existingOtp.attempts + 1 },
      });

      return errorResponse(res, "Invalid OTP", 400);
    }

    // Mark OTP used
    await prisma.otpCode.update({
      where: { id: existingOtp.id },
      data: { isUsed: true },
    });

    // Verify user
    await prisma.user.update({
      where: { email },
      data: { isVerified: true },
    });

    return successResponse(res, "OTP verified successfully", null, 200);
  } catch (error) {
    console.error("Verify OTP error:", error.message);
    return errorResponse(res, "Server error", 500);
  }
};

exports.signIn = async (req, res) => {
  try {
    const { email, password, license_code, device_type, fcm_token } = req.body;

    if (!email || !password || !license_code || device_type === undefined) {
      return errorResponse(res, "Required fields missing", 400);
    }

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      return errorResponse(res, "Invalid credentials", 400);
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return errorResponse(res, "Invalid credentials", 400);
    }

    // Validate license
    const license = await prisma.licenseCode.findUnique({
      where: { code: license_code },
    });

    if (!license) {
      return errorResponse(res, "Invalid license code", 400);
    }

    if (license.usedByUserId !== user.id) {
      return errorResponse(res, "License does not belong to this user", 400);
    }

    if (!license.isActive) {
      return errorResponse(res, "License inactive", 400);
    }

    if (new Date() > license.subscriptionEnd) {
      return errorResponse(res, "Subscription expired", 400);
    }

    // If not verified → resend OTP
    if (!user.isVerified) {
      await prisma.otpCode.deleteMany({
        where: { email, type: "signup" },
      });

      const otp = Math.floor(100000 + 900000 * Math.random()).toString();

      await prisma.otpCode.create({
        data: {
          email,
          otp,
          type: "signup",
          expiresAt: new Date(Date.now() + 60 * 1000),
        },
      });

      console.log("Login OTP:", otp);

      return errorResponse(res, "Account not verified. OTP sent again.", 403);
    }

    const token = jwt.sign(
      { userId: user.id, businessId: user.businessId },
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );

    const formattedUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      contact: user.phoneNumber,
      status: 1,
      user_type: 1,
      subscription_type: license.purchasePlan,
      device_type,
      fcm_token: fcm_token || null,
      created_at: user.createdAt,
      updated_at: user.updatedAt,
      deleted_at: user.deletedAt,
    };

    return res.status(200).json({
      success: true,
      message: "Login successful",
      data: {
        token,
        user: formattedUser,
      },
    });
  } catch (error) {
    console.error("Login error:", error.message);
    return errorResponse(res, "Server error", 500);
  }
};

exports.resendOtp = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return errorResponse(res, "Email is required", 400);
    }

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      return errorResponse(res, "User not found", 404);
    }

    await prisma.otpCode.deleteMany({
      where: { email, type: "signup" },
    });

    const otp = Math.floor(100000 + 900000 * Math.random()).toString();

    await prisma.otpCode.create({
      data: {
        email,
        otp,
        type: "signup",
        expiresAt: new Date(Date.now() + 60 * 1000),
      },
    });

    await sendOtpEmail(email, otp, "signup");

    return successResponse(res, "OTP resent successfully", null, 200);
  } catch (error) {
    console.error("Resend OTP error:", error.message);
    return errorResponse(res, "Server error", 500);
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return errorResponse(res, "Email is required", 400);
    }

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      return errorResponse(res, "User not found", 404);
    }

    await prisma.otpCode.deleteMany({
      where: { email, type: "forgot" },
    });

    const otp = Math.floor(100000 + 900000 * Math.random()).toString();

    await prisma.otpCode.create({
      data: {
        email,
        otp,
        type: "forgot",
        expiresAt: new Date(Date.now() + 60 * 1000),
      },
    });

    await sendOtpEmail(email, otp, "forgot");

    return successResponse(res, "OTP sent to email", null, 200);
  } catch (error) {
    return errorResponse(res, "Server error", 500);
  }
};

exports.verifyForgotOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;

    const existingOtp = await prisma.otpCode.findFirst({
      where: { email, type: "forgot", isUsed: false },
      orderBy: { createdAt: "desc" },
    });

    if (!existingOtp) {
      return errorResponse(res, "OTP not found", 400);
    }

    if (new Date() > existingOtp.expiresAt) {
      return errorResponse(res, "OTP expired", 400);
    }

    if (existingOtp.otp !== otp) {
      return errorResponse(res, "Invalid OTP", 400);
    }

    await prisma.otpCode.update({
      where: { id: existingOtp.id },
      data: { isUsed: true },
    });

    return successResponse(res, "OTP verified", null, 200);
  } catch (error) {
    return errorResponse(res, "Server error", 500);
  }
};

exports.resendForgotOtp = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return errorResponse(res, "Email is required", 400);
    }

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      return errorResponse(res, "User not found", 404);
    }

    // Delete previous forgot OTPs
    await prisma.otpCode.deleteMany({
      where: {
        email,
        type: "forgot",
      },
    });

    const otp = Math.floor(100000 + 900000 * Math.random()).toString();

    await prisma.otpCode.create({
      data: {
        email,
        otp,
        type: "forgot",
        expiresAt: new Date(Date.now() + 60 * 1000),
      },
    });

    await sendOtpEmail(email, otp, "forgot");

    return successResponse(res, "OTP resent successfully", null, 200);
  } catch (error) {
    console.error("Resend forgot OTP error:", error.message);
    return errorResponse(res, "Server error", 500);
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { email, new_password } = req.body;

    if (!email || !new_password) {
      return errorResponse(res, "Required fields missing", 400);
    }

    const hashedPassword = await bcrypt.hash(new_password, 10);

    await prisma.user.update({
      where: { email },
      data: { passwordHash: hashedPassword },
    });

    return successResponse(res, "Password reset successful", null, 200);
  } catch (error) {
    return errorResponse(res, "Server error", 500);
  }
};
