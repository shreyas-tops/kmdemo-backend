exports.successResponse = (res, message, data = null, statusCode = 200) => {
  return res.status(statusCode).json({
    message,
    status_code: statusCode,
    success: true,
    data,
  });
};

exports.errorResponse = (res, message, statusCode = 400) => {
  return res.status(statusCode).json({
    message,
    status_code: statusCode,
    success: false,
    data: null,
  });
};
