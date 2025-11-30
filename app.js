// app.js (frontend) - simplifié pour la démonstration
// Assumptions:
// - YOLO TFJS model placed in /modeles/yolo_web_model/model.json
// - MoveNet via @tensorflow-models/pose-detection

const MAX_SLOTS = 4;
const videoEls = [];
const canvasEls = [];
const ctxs = [];
const statuses = [];
const sensInputs = [];

for (let i=0;i<MAX_SLOTS;i++){
  videoEls[i] = document.getElementById(`video-${i}`);
  canvasEls[i] = document.getElementById(`canvas-${i}`);
  ctxs[i] = canvasEls[i].getContext('2d');
  statuses[i] = document.getElementById(`status-${i}`);
  sensInputs[i] = document.getElementById(`sens-${i}`);
  // Set canvas size when video metadata loaded
  videoEls[i].addEventListener('loadedmetadata', ()=> {
    canvasEls[i].width = videoEls[i].videoWidth;
    canvasEls[i].height = videoEls[i].videoHeight;
  });
}

// device selection for starting specific slot
const deviceSelect = document.getElementById('deviceSelect');
const slotSelect = document.getElementById('slotSelect');
const startBtn = document.getElementById('startCam');
const stopBtn = document.getElementById('stopCam');

let devices = [];
async function enumerateDevices(){
  const list = await navigator.mediaDevices.enumerateDevices();
  devices = list.filter(d=>d.kind==='videoinput');
  deviceSelect.innerHTML = devices.map((d,i)=>`<option value="${d.deviceId}">${d.label||'Cam '+(i+1)}</option>`).join('');
}
enumerateDevices();

// model placeholders
let yolomodel = null;
let poseDetector = null;

async function loadModels(){
  // 1) load YOLO TFJS (exported) - adjust path to your exported model
  try{
    // Example: tf.loadGraphModel for TFJS graph model
    yolomodel = await tf.loadGraphModel('/modeles/yolo_web_model/model.json');
    console.log('YOLO model loaded');
  }catch(e){ console.error('YOLO load failed', e); }

  // 2) load MoveNet via pose-detection
  const pose = window.poseDetection;
  const detectorConfig = {modelType: pose.movenet.modelType.SINGLEPOSE_LIGHTNING};
  poseDetector = await pose.createDetector(pose.SupportedModels.MoveNet, detectorConfig);
  console.log('Pose detector loaded');
}

loadModels();

// per-slot state
const state = Array.from({length:MAX_SLOTS}, ()=>({
  running:false,
  lastKeypoints:null,
  stillFrames:0,
  fallTimer:null,
  recording:false,
  mediaRecorder:null,
  recordedBlobs:[],
  lastSnapshot:null
}));

async function startSlot(slot, deviceId){
  if (!deviceId) deviceId = deviceSelect.value;
  const constraints = {video:{deviceId:{exact: deviceId}, width:640, height:480}};
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  videoEls[slot].srcObject = stream;
  state[slot].running = true;
  statuses[slot].textContent = 'running';
  // prepare recorder - only start on demand
  // start detection loop
  tick(slot);
}

function stopSlot(slot){
  const stream = videoEls[slot].srcObject;
  if (stream){
    stream.getTracks().forEach(t=>t.stop());
    videoEls[slot].srcObject = null;
  }
  state[slot].running = false;
  statuses[slot].textContent = 'idle';
}

startBtn.onclick = () => {
  const slot = parseInt(slotSelect.value,10);
  const d = deviceSelect.value;
  startSlot(slot, d);
};
stopBtn.onclick = () => {
  const slot = parseInt(slotSelect.value,10);
  stopSlot(slot);
};

// helper: compute euclidian dist between keypoints arrays (flattened)
function keypointsMovement(kp1, kp2){
  if (!kp1 || !kp2) return Infinity;
  let s=0, n=0;
  for (let i=0;i<kp1.length;i++){
    const a=kp1[i], b=kp2[i];
    if (!a || !b || a.score<0.2 || b.score<0.2) continue;
    const dx=a.x-b.x, dy=a.y-b.y;
    s += Math.sqrt(dx*dx + dy*dy);
    n++;
  }
  return n? s/n : Infinity;
}

// Heuristics: determine if person is lying: compute torso angle and center Y
function isLying(keypoints, canvasH){
  // keypoints: array with named positions (e.g. 0: nose, 11: left_hip, 12: right_hip, 5: left_shoulder, 6: right_shoulder)
  const leftShoulder = keypoints[5], rightShoulder = keypoints[6];
  const leftHip = keypoints[11], rightHip = keypoints[12];
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) return false;
  // torso center
  const sx = (leftShoulder.x+rightShoulder.x)/2;
  const sy = (leftShoulder.y+rightShoulder.y)/2;
  const hx = (leftHip.x+rightHip.x)/2;
  const hy = (leftHip.y+rightHip.y)/2;
  const angle = Math.atan2(hy-sy, hx-sx) * 180/Math.PI; // orientation
  // normalize angle to absolute (horizontal close to 0 or +-180)
  const absAngle = Math.abs(angle);
  const torsoAngleFromVertical = Math.abs(90 - Math.abs(absAngle));
  // if torso is near horizontal -> torsoAngleFromVertical small
  const torsoHorizontal = torsoAngleFromVertical < 30; // adjustable threshold
  // center Y near bottom (close to floor)
  const centerY = (sy+hy)/2;
  const nearFloor = centerY > canvasH * 0.6;
  return torsoHorizontal && nearFloor;
}

async function tick(slot){
  if (!state[slot].running) return;
  const video = videoEls[slot];
  if (video.readyState < 2) {
    requestAnimationFrame(()=>tick(slot));
    return;
  }
  const w = video.videoWidth, h = video.videoHeight;
  canvasEls[slot].width = w; canvasEls[slot].height = h;
  ctxs[slot].clearRect(0,0,w,h);
  // capture frame
  ctxs[slot].drawImage(video,0,0,w,h);
  const imgData = ctxs[slot].getImageData(0,0,w,h);

  // 1) run YOLO model to detect person
  // NOTE: TFJS graph models expect tensors normalized; this depends on export. Here is a naive pipeline:
  if (yolomodel){
    // convert frame to tensor
    const t = tf.browser.fromPixels(video).expandDims(0).toFloat().div(255.0);
    // model-specific input resize could be necessary: adapt to your exported model's input shape
    try{
      const out = await yolomodel.executeAsync(t);
      // out processing depends on your export; here we assume off-the-shelf detection output (boxes/scores/classes)
      // For production, adapt parsing to the exported YOLO tfjs format.
      // ---- placeholder pseudo logic start ----
      // parseOut(...);
      // find highest person bbox
      // ---- placeholder pseudo logic end ----
      tf.dispose(out);
    }catch(e){
      console.warn('yolo infer error', e);
    }
    tf.dispose(t);
  }

  // 2) pose detection (full frame or inside bbox if YOLO bbox available)
  try{
    const poses = await poseDetector.estimatePoses(video, {maxPoses:1});
    if (poses && poses.length>0){
      const kp = poses[0].keypoints;
      // draw keypoints
      kp.forEach(k=> {
        if (k.score>0.3){
          ctxs[slot].beginPath();
          ctxs[slot].arc(k.x, k.y, 3, 0, Math.PI*2);
          ctxs[slot].fillStyle = 'lime';
          ctxs[slot].fill();
        }
      });

      // movement check vs previous
      const move = keypointsMovement(kp, state[slot].lastKeypoints);
      state[slot].lastKeypoints = kp;
      // sensitivity maps to movement threshold
      const sens = parseInt(sensInputs[slot].value,10);
      const moveThreshold = 0.5 / sens; // tweak empirically

      if (move === Infinity) {
        // first frame
        state[slot].stillFrames = 0;
      } else if (move < moveThreshold) {
        state[slot].stillFrames += 1;
      } else {
        state[slot].stillFrames = 0;
      }

      // detect lying
      const lying = isLying(kp, h);

      // if lying & stillFrames large -> start countdown if not running
      // we use fps assumption ~10 frames/s (better: measure dt)
      const secondsStill = state[slot].stillFrames / 10;
      if (lying && secondsStill >= 2){ // require a short confirmation (2s) before starting 30s timer
        // start 30s timer if not already
        if (!state[slot].fallTimer){
          state[slot].fallTimer = {
            started: Date.now(),
            remaining: 30
          };
        } else {
          const elapsed = Math.floor((Date.now() - state[slot].fallTimer.started)/1000);
          state[slot].fallTimer.remaining = 30 - elapsed;
          // draw countdown
          ctxs[slot].fillStyle = 'rgba(255,0,0,0.6)';
          ctxs[slot].fillRect(10,10,120,36);
          ctxs[slot].fillStyle = 'white';
          ctxs[slot].font = '20px monospace';
          ctxs[slot].fillText(`ALERT ${Math.max(0,state[slot].fallTimer.remaining)}s`, 16,34);
          // if reached 0 -> trigger alert
          if (state[slot].fallTimer.remaining <= 0){
            triggerAlert(slot);
            // reset
            state[slot].fallTimer = null;
            state[slot].stillFrames = 0;
          }
        }
      } else {
        // reset timer
        state[slot].fallTimer = null;
      }

    }
  }catch(e){
    console.warn('pose infer error', e);
  }

  requestAnimationFrame(()=>tick(slot));
}

// Trigger alert: snapshot + start recording upload + call backend
async function triggerAlert(slot){
  statuses[slot].textContent = 'ALERTE';
  // take snapshot
  const dataUrl = canvasEls[slot].toDataURL('image/jpeg', 0.8);
  state[slot].lastSnapshot = dataUrl;

  // Start a short recording via MediaRecorder (e.g. 20s) to capture context
  const stream = videoEls[slot].srcObject;
  if (stream && !state[slot].recording){
    const options = {mimeType: 'video/webm; codecs=vp8'};
    const mr = new MediaRecorder(stream, options);
    state[slot].recordedBlobs = [];
    mr.ondataavailable = e=> { if (e.data && e.data.size) state[slot].recordedBlobs.push(e.data); };
    mr.onstop = async ()=>{
      // prepare FormData and send to backend
      const blob = new Blob(state[slot].recordedBlobs, {type:'video/webm'});
      const form = new FormData();
      form.append('slot', slot);
      form.append('timestamp', new Date().toISOString());
      form.append('snapshot', dataURItoBlob(dataUrl), 'snapshot.jpg');
      form.append('video', blob, 'capture.webm');
      // send to backend
      try{
        const res = await fetch('/api/alert', {method:'POST', body: form});
        console.log('alert response', await res.text());
      }catch(e){ console.error('alert upload failed', e); }
    };
    mr.start();
    state[slot].recording = true;
    // stop recorder after 20s
    setTimeout(()=>{ mr.stop(); state[slot].recording=false; }, 20_000);
  } else {
    // no stream -> just send snapshot
    const form = new FormData();
    form.append('slot', slot);
    form.append('timestamp', new Date().toISOString());
    form.append('snapshot', dataURItoBlob(dataUrl), 'snapshot.jpg');
    fetch('/api/alert', {method:'POST', body: form}).then(r=>r.text()).then(t=>console.log(t));
  }
}

function dataURItoBlob(dataURI) {
  const byteString = atob(dataURI.split(',')[1]);
  const mimeString = dataURI.split(',')[0].split(':')[1].split(';')[0];
  const ab = new ArrayBuffer(byteString.length);
  const ia = new Uint8Array(ab);
  for (let i=0;i<byteString.length;i++) ia[i]=byteString.charCodeAt(i);
  return new Blob([ab], {type:mimeString});
}
