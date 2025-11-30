const CAMERAS = ["cam1", "cam2", "cam3", "cam4"];
let model;

// Timer pour chaque caméra
let fallTimers = {
    cam1: 0,
    cam2: 0,
    cam3: 0,
    cam4: 0
};

async function start() {
    model = await tf.loadGraphModel("../models/yolo11_web_model/model.json");

    // Démarrer les webcams
    CAMERAS.forEach((camId, index) => {
        const video = document.getElementById(camId);
        navigator.mediaDevices.getUserMedia({ video: { deviceId: undefined } })
            .then(stream => { video.srcObject = stream; })
            .catch(err => console.error("Erreur webcam:", err));

        // Démarrer l'analyse
        video.addEventListener("loadeddata", () => analyzeCamera(camId));
    });
}

async function analyzeCamera(camId) {
    const video = document.getElementById(camId);
    const canvas = document.getElementById("canvas" + camId.substring(3));
    const ctx = canvas.getContext("2d");

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    async function loop() {
        const input = tf.browser.fromPixels(video).expandDims(0);
        const predictions = await model.executeAsync(input);

        const fallen = detectFall(predictions);
        drawDetections(predictions, ctx);

        if (fallen) {
            fallTimers[camId]++;
            if (fallTimers[camId] === 30) {
                triggerAlert(camId, video);
            }
        } else {
            fallTimers[camId] = 0;
        }

        requestAnimationFrame(loop);
    }

    loop();
}

function detectFall(pred) {
    // Filtre YOLO : si personne détectée couchée horizontalement
    const threshold = parseFloat(document.getElementById("sensitivity").value);

    // Exemple simplifié (à adapter selon sorties YOLOv11)
    const boxes = pred[0].arraySync();
    const scores = pred[1].arraySync();

    for (let i = 0; i < boxes.length; i++) {
        if (scores[i] > threshold) {
            const [y1, x1, y2, x2] = boxes[i];
            const width = x2 - x1;
            const height = y2 - y1;

            if (width > height * 1.5) {
                return true; // Personne allongée
            }
        }
    }
    return false;
}

function drawDetections(pred, ctx) {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    // Dessin simplifié
}

async function triggerAlert(camId, video) {
    console.log("ALERTE ! Chute détectée sur", camId);

    // Création screenshot
    const screenshot = await createScreenshot(video);

    // Envoi au backend
    fetch("http://localhost:3000/alert/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            camera: camId,
            screenshot: screenshot
        })
    });
}

function createScreenshot(video) {
    const c = document.createElement("canvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(video, 0, 0);
    return c.toDataURL("image/png");
}

start();
