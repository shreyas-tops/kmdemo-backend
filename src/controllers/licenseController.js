const prisma = require("../config/prisma");
const { successResponse, errorResponse } = require("../utils/response");

const generatePrefix = (businessName) => {
  const cleaned = businessName.replace(/[^a-zA-Z ]/g, "");
  const firstWord = cleaned.split(" ")[0];
  return firstWord.substring(0, 6).toUpperCase();
};

const validPlans = [1, 3, 6, 12];

exports.createLicense = async (req, res) => {
  try {
    const { business_name, purchase_plan: purchasePlanRaw } = req.body;

    if (!business_name) {
      return errorResponse(
        res,
        "Business name and purchase plan are required",
        400,
      );
    }

    const purchase_plan = Number(purchasePlanRaw);
    if (
      Number.isNaN(purchase_plan) ||
      !Number.isInteger(purchase_plan) ||
      !validPlans.includes(purchase_plan)
    ) {
      return errorResponse(
        res,
        "Invalid purchase plan. Allowed: 1,3,6,12 months",
        400,
      );
    }

    const prefix = generatePrefix(business_name);

    const lastLicense = await prisma.licenseCode.findFirst({
      where: { prefix },
      orderBy: { sequence: "desc" },
    });

    const nextSequence = lastLicense ? lastLicense.sequence + 1 : 1;
    const paddedNumber = String(nextSequence).padStart(3, "0");
    const code = `${prefix}${paddedNumber}`;

    const startDate = new Date();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + purchase_plan);

    const newLicense = await prisma.licenseCode.create({
      data: {
        code,
        businessName: business_name,
        prefix,
        sequence: nextSequence,
        purchasePlan: purchase_plan,
        subscriptionStart: startDate,
        subscriptionEnd: endDate,
      },
    });

    const formattedResponse = {
      id: newLicense.id,
      code: newLicense.code,
      businessName: newLicense.businessName,
      purchasePlan: newLicense.purchasePlan,
      subscriptionStart: newLicense.subscriptionStart,
      subscriptionEnd: newLicense.subscriptionEnd,
      isActive: newLicense.isActive,
      isUsed: newLicense.isUsed,
      usedByUserId: newLicense.usedByUserId,
      usedAt: newLicense.usedAt,
      createdAt: newLicense.createdAt,
    };

    return successResponse(
      res,
      "License created successfully",
      formattedResponse,
      200,
    );
  } catch (error) {
    console.error("License create error:", error.message);
    if (error.code) console.error("Prisma code:", error.code);
    return errorResponse(res, "Server error", 500);
  }
};
