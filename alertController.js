const fs = require("fs");
const twilio = require("twilio");
const axios = require("axios");

exports.sendAlert = async (req, res) => {
    const { camera, screenshot } = req.body;

    // Décoder l’image
    const base64Data = screenshot.replace(/^data:image\/png;base64,/, "");
    const filename = `captures/screenshots/${Date.now()}_${camera}.png`;
    fs.writeFileSync(filename, base64Data, "base64");

    // ----------------------------
    // 1) ENVOI SMS FREE MOBILE
    // ----------------------------
    const url = `https://smsapi.free-mobile.fr/sendmsg?user=${process.env.FREE_USER}&pass=${process.env.FREE_PASS}&msg=CHUTE DETECTEE camera ${camera}`;
    await axios.get(url);

    // ----------------------------
    // 2) ENVOI MESSAGE WHATSAPP TWILIO
    // ----------------------------
    const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

    await client.messages.create({
        body: `Alerte : chute détectée sur ${camera}`,
        from: `whatsapp:${process.env.TWILIO_WHATSAPP}`,
        to: `whatsapp:${process.env.ALERT_WHATSAPP}`,
    });

    res.json({ status: "Alerte envoyée" });
};
