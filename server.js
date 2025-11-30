require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

app.use("/alert", require("./routes/alert"));

app.listen(3000, () => {
    console.log("Backend démarré sur http://localhost:3000");
});
