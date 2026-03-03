const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

exports.sendOtpEmail = async (toEmail, otp, type = "signup") => {
  let subject = "";
  let heading = "";
  let subheading = "";

  if (type === "signup") {
    subject = "Verify Your Account - Catering App";
    heading = "Verify Your Email Address";
    subheading =
      "Thanks for signing up! Use the OTP below to verify your account.";
  } else if (type === "forgot") {
    subject = "Reset Your Password - Catering App";
    heading = "Password Reset Request";
    subheading =
      "We received a request to reset your password. Use the OTP below to proceed.";
  }

  const htmlTemplate = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    <title>OTP Email</title>
  </head>
  <body style="margin:0; padding:0; background-color:#f4f4f7; font-family: Arial, sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7; padding: 40px 0;">
      <tr>
        <td align="center">
          <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:10px; overflow:hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.1);">
            
            <!-- Header -->
            <tr>
              <td style="background: linear-gradient(135deg, #FF6B35, #F7931E); padding: 40px 30px; text-align:center;">
                <h1 style="margin:0; color:#ffffff; font-size:26px; letter-spacing:1px;">🍽️ Catering App</h1>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding: 40px 40px 20px 40px; text-align:center;">
                <h2 style="margin:0 0 10px 0; color:#333333; font-size:22px;">${heading}</h2>
                <p style="margin:0 0 30px 0; color:#666666; font-size:15px; line-height:1.6;">${subheading}</p>

                <!-- OTP Box -->
                <div style="display:inline-block; background-color:#FFF5EC; border: 2px dashed #FF6B35; border-radius:10px; padding: 20px 40px; margin-bottom:30px;">
                  <p style="margin:0 0 8px 0; color:#999999; font-size:13px; text-transform:uppercase; letter-spacing:2px;">Your OTP Code</p>
                  <h1 style="margin:0; font-size:48px; letter-spacing:12px; color:#FF6B35; font-weight:900;">${otp}</h1>
                </div>

                <!-- Timer Notice -->
                <div style="background-color:#FFF3CD; border-left: 4px solid #FFC107; border-radius:4px; padding:12px 20px; text-align:left; margin-bottom:20px;">
                  <p style="margin:0; color:#856404; font-size:13px;">
                    ⏱️ <strong>This OTP is valid for 1 minute only.</strong> Please do not share it with anyone.
                  </p>
                </div>

                <p style="color:#999999; font-size:13px; line-height:1.6;">
                  If you didn't request this, you can safely ignore this email.<br/>No changes will be made to your account.
                </p>
              </td>
            </tr>

            <!-- Divider -->
            <tr>
              <td style="padding: 0 40px;">
                <hr style="border:none; border-top:1px solid #eeeeee;" />
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="padding: 20px 40px 30px 40px; text-align:center;">
                <p style="margin:0; color:#aaaaaa; font-size:12px;">
                  © ${new Date().getFullYear()} Catering App · All rights reserved<br/>
                  Need help? <a href="mailto:support@cateringapp.com" style="color:#FF6B35; text-decoration:none;">Contact Support</a>
                </p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;

  const from = process.env.EMAIL_FROM || "Catering App <onboarding@resend.dev>";

  const { data, error } = await resend.emails.send({
    from,
    to: toEmail,
    subject,
    html: htmlTemplate,
  });

  if (error) {
    console.error("Resend error:", error);
    throw new Error(error.message || "Failed to send email");
  }

  return data;
};
