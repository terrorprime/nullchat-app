// Prints a long random string (used as APP_SECRET by "Deploy to Fly.io.bat").
console.log(require('node:crypto').randomBytes(32).toString('hex'));
