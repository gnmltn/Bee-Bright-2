const { validationResult } = require('express-validator');

/**
 * Validation middleware
 * Runs express-validator validations and returns errors if any
 */
const validate = (validations) => {
  return async (req, res, next) => {
    // Run all validations
    await Promise.all(validations.map(validation => validation.run(req)));
    
    // Check for errors
    const errors = validationResult(req);
    
    if (errors.isEmpty()) {
      return next();
    }
    
    // Return validation errors
    const all = errors.array();
    // An invalid email gets its own specific sentence (which character is not allowed,
    // etc.) as the top-level message so clients that only show `message` stay clear.
    const emailError = all.find((e) => e.path === 'email');
    res.status(400).json({
      success: false,
      message: emailError?.msg || 'Validation failed',
      errors: all
    });
  };
};

module.exports = { validate };