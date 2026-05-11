const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const qrcode = require('qrcode');

const server = http.createServer((req, res) => {
    if (req.url.startsWith('/assets/')) {
        const filePath = path.join(__dirname, req.url);
        const ext = path.extname(filePath).toLowerCase();
        const contentTypes = {
            '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
        };
        const contentType = contentTypes[ext] || 'application/octet-stream';
        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); res.end(); return; }
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        });
        return;
    }
    
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) { res.writeHead(500); res.end(); return; }
            res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
            res.end(data);
        });
        return;
    }
    
    if (req.url === '/control' || req.url === '/control.html') {
        fs.readFile(path.join(__dirname, 'visualizer.html'), (err, data) => {
            if (err) { res.writeHead(500); res.end(); return; }
            res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
            res.end(data);
        });
        return;
    }
    
    res.writeHead(404);
    res.end();
});

const wss = new WebSocket.Server({ server });

let vjState = {
    flameIntensity: 1.0, noiseDeform: 0.6, deformSpeed: 1.0,
    rotX: 0.3, rotY: 0.5, zoom: 5.5,
    charDensity: 1.0, charset: 'full', masterHue: 180, masterSat: 1.4, masterLight: 1.0,
    colorMode: 'full', warpIntensity: 0.5,
    audioActive: false, audioBand: 0, audioAmp: 1.3, smoothFactor: 0.75,
    webcamActive: false, webcamMix: 0.5
};

let vjScreen = null;
let controllers = new Map();
let nextControllerId = 1;

function broadcastState(exceptWs = null) {
    const message = JSON.stringify({ type: 'state_update', state: vjState });
    if (vjScreen && vjScreen.readyState === WebSocket.OPEN && vjScreen !== exceptWs) {
        vjScreen.send(message);
    }
    for (let [id, controller] of controllers) {
        if (controller.ws !== exceptWs && controller.ws.readyState === WebSocket.OPEN) {
            controller.ws.send(message);
        }
    }
}

function sendFullState(ws) {
    ws.send(JSON.stringify({ type: 'full_state', state: vjState, controllersCount: controllers.size }));
}

function sendControllersUpdate() {
    const controllersList = [];
    for (let [id, controller] of controllers) {
        controllersList.push({ id: id, name: controller.name });
    }
    const message = JSON.stringify({ type: 'controllers_update', controllers: controllersList, count: controllersList.length });
    if (vjScreen && vjScreen.readyState === WebSocket.OPEN) vjScreen.send(message);
    for (let [id, controller] of controllers) {
        if (controller.ws.readyState === WebSocket.OPEN) controller.ws.send(message);
    }
}

wss.on('connection', (ws) => {
    console.log('🔌 Nuevo dispositivo conectado');
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📨 Mensaje:', data.type);
            
            if (data.type === 'register_vj') {
                vjScreen = ws;
                console.log('🖥️ VJ Screen conectada');
                sendFullState(ws);
                sendControllersUpdate();
            }
            
            if (data.type === 'register_controller') {
                const controllerId = nextControllerId++;
                const controllerName = data.controllerName || `VJ ${controllerId}`;
                controllers.set(controllerId, { id: controllerId, ws: ws, name: controllerName });
                console.log(`🎮 Controlador "${controllerName}" conectado`);
                ws.send(JSON.stringify({ type: 'controller_init', controllerId: controllerId, state: vjState, controllersCount: controllers.size }));
                sendControllersUpdate();
            }
            
            if (data.type === 'param_update') {
                if (vjState.hasOwnProperty(data.param)) {
                    vjState[data.param] = data.value;
                    console.log(`🎛️ ${data.param} = ${data.value} (por ${data.controllerName || '?'})`);
                    broadcastState(ws);
                }
            }
            
            if (data.type === 'glitch_burst') {
                console.log(`💥 GLITCH BURST`);
                if (vjScreen && vjScreen.readyState === WebSocket.OPEN) {
                    vjScreen.send(JSON.stringify({ type: 'glitch_burst', intensity: data.intensity || 1.0 }));
                }
            }
            
            if (data.type === 'reset_state') {
                vjState = {
                    flameIntensity: 1.0, noiseDeform: 0.6, deformSpeed: 1.0,
                    rotX: 0.3, rotY: 0.5, zoom: 5.5,
                    charDensity: 1.0, charset: 'full', masterHue: 180, masterSat: 1.4, masterLight: 1.0,
                    colorMode: 'full', warpIntensity: 0.5,
                    audioActive: false, audioBand: 0, audioAmp: 1.3, smoothFactor: 0.75,
                    webcamActive: false, webcamMix: 0.5
                };
                console.log(`🔄 Reset completo`);
                broadcastState();
            }
            
            if (data.type === 'request_state') sendFullState(ws);
            
        } catch (e) { console.log('Error:', e.message); }
    });
    
    ws.on('close', () => {
        if (ws === vjScreen) { vjScreen = null; console.log('🖥️ VJ Screen desconectada'); }
        let disconnectedId = null;
        for (let [id, controller] of controllers) {
            if (controller.ws === ws) { disconnectedId = id; console.log(`🎮 Controlador "${controller.name}" desconectado`); break; }
        }
        if (disconnectedId) { controllers.delete(disconnectedId); sendControllersUpdate(); }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    const url = `http://${ip}:${PORT}`;
    const controlUrl = `http://${ip}:${PORT}/control`;
    
    console.log('\n' + '='.repeat(60));
    console.log('🎛️ VJ COLLABORATIVE VISUALIZER');
    console.log('='.repeat(60));
    console.log(`\n🖥️ PANTALLA VJ (Proyector/PC): ${url}`);
    console.log(`📱 CONTROLADORES MÓVILES: ${controlUrl}`);
    
    qrcode.toString(controlUrl, { type: 'terminal', small: true }, (err, qr) => {
        if (!err) console.log('\n📱 CÓDIGO QR:\n' + qr);
        console.log('\n' + '='.repeat(60));
        console.log('🎤 MIC y 📷 WEBCAM se activan desde los controles móviles');
        console.log('Presiona Ctrl+C para detener\n');
    });
});

function getLocalIP() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) return net.address;
        }
    }
    return 'localhost';
}