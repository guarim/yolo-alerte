const router = require("express").Router();
const { sendAlert } = require("../controllers/alertController");

router.post("/send", sendAlert);

module.exports = router;
