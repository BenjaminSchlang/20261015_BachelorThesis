<script>
  import { onMount, tick } from 'svelte';
  import mqtt from 'mqtt';
  import { Chart, registerables } from 'chart.js';

  Chart.register(...registerables);

  // --- CONFIGURATION ---
  const SERVER_IP = '192.168.0.208'; 
  const WS_PORT = '1880';          
  const MQTT_WS_PORT = '9001';     

  // 1. Svelte 5 Runes für unabhängige Variablen
  let protocol = $state('ws');
  let frequencyHz = $state(10);     // 10, 50, 200 Hz
  let domRows = $state(50);         // 10, 50, 100 Zeilen
  let payloadSizeKb = $state(1);    // 0.1, 1, 10 KB

  // Dynamische Payload (Memoisiert durch Compiler)
  let dummyPayload = $derived('A'.repeat(Math.round(payloadSizeKb * 1024)));

  // 2. Netzwerk & Telemetrie States
  let isConnected = $state(false);
  let messages = $state([]);
  let fps = $state(0);
  let processingTime = $state(0);
  let throughput = $state(0); 

  // 3. Benchmark States
  let isBenchmarking = $state(false);
  let benchmarkTimeLeft = $state(0);
  let benchmarkResult = $state(null);

  // 4. Nicht-reaktive Variablen (Refs) für stabile Lebenszyklen
  let canvasRef;
  let chartInstance = null;
  let packetIdCounter = 0;
  let lastPacketTimestamp = 0;
  let receivedBytesInSecond = 0;
  
  let wsClient = null;
  let mqttClient = null;
  let sendInterval = null;

  // --- NEU: Variablen für die exakte Render-Zeitmessung ---
  let packetProcessStart = 0;
  let latestProcTime = 0;

  // Benchmark Collector
  let isBenchmarkingRef = false;
  let benchmarkData = { latencies: [], processingTimes: [], fpsList: [], packetsReceived: 0 };

  // --- LEBENSZYKLUS & FPS COUNTER ---
  let animationFrameId;
  onMount(() => {
    let frameCount = 0;
    let lastTime = performance.now();

    const calcFPS = () => {
      const now = performance.now();
      frameCount++;
      if (now - lastTime >= 1000) {
        fps = frameCount;
        if (isBenchmarkingRef) {
          benchmarkData.fpsList.push(frameCount);
        }
        frameCount = 0;
        lastTime = now;
      }
      animationFrameId = requestAnimationFrame(calcFPS);
    };

    animationFrameId = requestAnimationFrame(calcFPS);

    const tpInterval = setInterval(() => {
      throughput = (receivedBytesInSecond / 1024).toFixed(2);
      receivedBytesInSecond = 0;
    }, 1000);

    initChart();
    connect();

    return () => {
      cancelAnimationFrame(animationFrameId);
      clearInterval(tpInterval);
      disconnect();
      if (chartInstance) chartInstance.destroy();
    };
  });

  // --- MULTI-TRACE CHART INITIALISIERUNG (3 Spuren) ---
  function initChart() {
    if (chartInstance) chartInstance.destroy();
    if (!canvasRef) return;

    chartInstance = new Chart(canvasRef, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: '1-Way Latenz (ms)',
            data: [],
            borderColor: 'rgb(53, 162, 235)',
            backgroundColor: 'rgba(53, 162, 235, 0.5)',
            tension: 0.1,
            pointRadius: 1,
            yAxisID: 'y',
          },
          {
            label: 'Jitter (ms)',
            data: [],
            borderColor: 'rgb(255, 159, 64)',
            backgroundColor: 'rgba(255, 159, 64, 0.5)',
            borderDash: [4, 4],
            tension: 0.1,
            pointRadius: 1,
            yAxisID: 'y',
          },
          {
            label: 'Scripting Time (ms)',
            data: [],
            borderColor: 'rgb(75, 192, 192)',
            backgroundColor: 'rgba(75, 192, 192, 0.5)',
            tension: 0.1,
            pointRadius: 1,
            yAxisID: 'y',
          }
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          y: { title: { display: true, text: 'Zeit (ms)' }, beginAtZero: true },
          x: { title: { display: true, text: 'Paket ID' } },
        },
      },
    });
  }

  function updateChart(currentMessages) {
    if (!chartInstance) return;
    const reversed = currentMessages.slice(0, 100).reverse();
    chartInstance.data.labels = reversed.map((m) => `#${m.id}`);
    chartInstance.data.datasets[0].data = reversed.map((m) => m.oneWayLatency);
    chartInstance.data.datasets[1].data = reversed.map((m) => m.jitter);
    chartInstance.data.datasets[2].data = reversed.map((m) => m.procTime);
    chartInstance.update();
  }

  // --- NETZWERK & MELDUNGSVERARBEITUNG ---
  function sendPing(sendFn) {
    packetIdCounter += 1;
    const packet = { id: packetIdCounter, sendTimestamp: performance.now(), payload: dummyPayload };
    sendFn(JSON.stringify(packet));
  }

  // NEU: async Keyword, da wir auf das native DOM-Update von Svelte warten (tick)
  async function handlePong(rawMessage) {
    // STARTZEITPUNKT
    if (packetProcessStart === 0) {
      packetProcessStart = performance.now();
    }
    
    const receiveTimestamp = performance.now();
    receivedBytesInSecond += rawMessage.length;
    
    // JSON Parsing (CPU Last)
    const data = JSON.parse(rawMessage);
    
    // Latenz & Jitter berechnen
    const rtt = receiveTimestamp - data.sendTimestamp;
    const oneWayLatency = parseFloat((rtt / 2).toFixed(3));

    const prevLatency = lastPacketTimestamp ? lastPacketTimestamp : oneWayLatency;
    const currentJitter = parseFloat(Math.abs(oneWayLatency - prevLatency).toFixed(3));
    lastPacketTimestamp = oneWayLatency;

    // Rohdaten-Sammlung (Latenz und Paketverlust)
    if (isBenchmarkingRef) {
      benchmarkData.latencies.push(oneWayLatency);
      benchmarkData.packetsReceived += 1;
    }

    // Direct Signal Update (triggert Svelte Reaktivität im Hintergrund)
    messages = [
      { 
        id: data.id, 
        oneWayLatency, 
        rtt: parseFloat(rtt.toFixed(3)), 
        jitter: currentJitter, 
        procTime: latestProcTime 
      }, 
      ...messages.slice(0, 999)
    ];
    updateChart(messages);

    // --- NEU: VIRTUAL DOM / REAL DOM MESSUNG ---
    // Wir warten, bis Svelte die Änderungen nativ in das HTML-DOM geschrieben hat.
    await tick();

    if (packetProcessStart !== 0) {
      const renderEnd = performance.now();
      const trueRenderTime = parseFloat((renderEnd - packetProcessStart).toFixed(3));
      
      latestProcTime = trueRenderTime;
      processingTime = trueRenderTime; // UI Update

      if (isBenchmarkingRef) {
        benchmarkData.processingTimes.push(trueRenderTime);
      }
      
      // Timer für das nächste Paket zurücksetzen
      packetProcessStart = 0;
    }
  }

  function disconnect() {
    if (sendInterval) clearInterval(sendInterval);
    if (wsClient) wsClient.close();
    if (mqttClient) mqttClient.end();
    isConnected = false;
  }

  function connect() {
    disconnect();
    messages = [];
    packetIdCounter = 0;
    initChart();
    const pingIntervalMs = 1000 / frequencyHz;

    if (protocol === 'ws') {
      wsClient = new WebSocket(`ws://${SERVER_IP}:${WS_PORT}/ws/benchmark`);
      wsClient.onopen = () => {
        isConnected = true;
        sendInterval = setInterval(() => {
          if (wsClient.readyState === WebSocket.OPEN) sendPing((msg) => wsClient.send(msg));
        }, pingIntervalMs);
      };
      wsClient.onclose = () => isConnected = false;
      wsClient.onmessage = (event) => handlePong(event.data);
    } else if (protocol === 'mqtt') {
      mqttClient = mqtt.connect(`ws://${SERVER_IP}:${MQTT_WS_PORT}`);
      mqttClient.on('connect', () => {
        isConnected = true;
        mqttClient.subscribe('benchmark/pong');
        sendInterval = setInterval(() => {
          if (mqttClient.connected) sendPing((msg) => mqttClient.publish('benchmark/ping', msg));
        }, pingIntervalMs);
      });
      mqttClient.on('offline', () => { isConnected = false; });
      mqttClient.on('message', (topic, message) => handlePong(message.toString()));
    }
  }

  function handleConfigChange() {
    connect();
  }

  // --- BENCHMARK LOGIC ---
  function runBenchmark() {
    benchmarkResult = null;
    isBenchmarking = true;
    isBenchmarkingRef = true;
    benchmarkData = { latencies: [], processingTimes: [], fpsList: [], packetsReceived: 0 };
    
    benchmarkTimeLeft = 60;
    
    const countdown = setInterval(() => {
      benchmarkTimeLeft -= 1;
      if (benchmarkTimeLeft <= 0) {
        clearInterval(countdown);
        finishBenchmark();
      }
    }, 1000);
  }

  function finishBenchmark() {
    isBenchmarking = false;
    isBenchmarkingRef = false;

    const { latencies, processingTimes, fpsList, packetsReceived } = benchmarkData;
    
    const calcAggregates = (arr) => {
      if(arr.length === 0) return { min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
      const sorted = [...arr].sort((a, b) => a - b);
      const sum = sorted.reduce((a, b) => a + b, 0);
      return {
        min: sorted[0].toFixed(2),
        max: sorted[sorted.length - 1].toFixed(2),
        avg: (sum / sorted.length).toFixed(2),
        p50: sorted[Math.floor(sorted.length * 0.50)].toFixed(2),
        p95: sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
        p99: sorted[Math.floor(sorted.length * 0.99)].toFixed(2),
      };
    };

    const expectedPackets = 60 * frequencyHz;
    const lossRate = Math.max(0, ((expectedPackets - packetsReceived) / expectedPackets) * 100).toFixed(2);

    benchmarkResult = {
      config: { framework: 'Svelte 5', protocol, frequencyHz, domRows, payloadSizeKb: `${payloadSizeKb} KB`, duration: '60s' },
      latency: calcAggregates(latencies),
      scriptingTime: calcAggregates(processingTimes),
      fps: calcAggregates(fpsList),
      packetLoss: `${lossRate}% (${packetsReceived}/${expectedPackets})`
    };
  }
</script>

<main style="font-family: sans-serif; padding: 20px; max-width: 1050px; margin: 0 auto;">
  <h1>Svelte 5 Telemetry Benchmark</h1>

  <!-- KONTROLLZENTRUM -->
  <div style="padding: 15px; background: #f5f5f5; border-radius: 8px; margin-bottom: 20px; display: flex; flex-wrap: wrap; gap: 15px; align-items: center;">
    <div>
      <strong>Protokoll: </strong>
      <select bind:value={protocol} onchange={handleConfigChange} disabled={isBenchmarking}>
        <option value="ws">Native WS</option>
        <option value="mqtt">MQTT over WS</option>
      </select>
    </div>
    <div>
      <strong>Frequenz: </strong>
      <select bind:value={frequencyHz} onchange={handleConfigChange} disabled={isBenchmarking}>
        <option value={10}>10 Hz (Baseline)</option>
        <option value={50}>50 Hz (Real-Time)</option>
        <option value={200}>200 Hz (Stress Test)</option>
      </select>
    </div>
    <div>
      <strong>DOM-Last: </strong>
      <select bind:value={domRows} disabled={isBenchmarking}>
        <option value={10}>10 Zeilen</option>
        <option value={50}>50 Zeilen</option>
        <option value={100}>100 Zeilen</option>
        <option value={500}>500 Zeilen</option>
        <option value={1000}>1000 Zeilen</option>
      </select>
    </div>
    <div>
      <strong>Payload: </strong>
      <select bind:value={payloadSizeKb} onchange={handleConfigChange} disabled={isBenchmarking}>
        <option value={0.1}>100 Bytes</option>
        <option value={1}>1 KB</option>
        <option value={10}>10 KB</option>
        <option value={100}>100 KB</option>
      </select>
    </div>
    
    <div style="margin-left: auto; display: flex; gap: 10px; align-items: center;">
      <span style="color: {isConnected ? 'green' : 'red'}; font-weight: bold;">
        ● {isConnected ? 'Verbunden' : 'Getrennt'}
      </span>
      <button 
        onclick={runBenchmark} 
        disabled={!isConnected || isBenchmarking}
        style="background: {isBenchmarking ? '#ccc' : '#e63946'}; color: #fff; padding: 10px 15px; border: none; border-radius: 5px; font-weight: bold; cursor: {isBenchmarking ? 'not-allowed' : 'pointer'};">
        {isBenchmarking ? `Benchmark läuft... (${benchmarkTimeLeft}s)` : 'Start 60s Benchmark'}
      </button>
    </div>
  </div>

  <!-- BENCHMARK REPORT MODAL -->
  {#if benchmarkResult}
    <div style="padding: 20px; background: #e3f2fd; border: 1px solid #90caf9; border-radius: 8px; margin-bottom: 20px;">
      <h2 style="margin: 0 0 10px 0; color: #1565c0;">Benchmark Abgeschlossen (Svelte 5)</h2>
      <textarea 
        readonly 
        value={JSON.stringify(benchmarkResult, null, 2)} 
        style="width: 100%; height: 220px; font-family: monospace; font-size: 13px; padding: 10px;"
      ></textarea>
    </div>
  {/if}

  <!-- LIVE KPIs -->
  <div style="display: flex; gap: 15px; font-size: 14px; background: #e0e0e0; padding: 10px 15px; border-radius: 6px; margin-bottom: 20px;">
    <div>UI Frame Rate: <strong style="color: {fps < (frequencyHz === 200 ? 100 : 45) ? 'red' : 'green'};">{fps} FPS</strong></div>
    <div>Processing Time: <strong>{processingTime} ms</strong></div>
    <div>Throughput: <strong>{throughput} KB/s</strong></div>
  </div>

  <!-- Multi-Trace Diagramm -->
  <div style="margin-bottom: 20px; padding: 15px; border: 1px solid #ddd; border-radius: 8px; height: 300px;">
    <canvas bind:this={canvasRef}></canvas>
  </div>

  <!-- COMPLEX DOM TABLE -->
  <h3>Telemetrie-Historie (Erweiterte DOM-Struktur: {domRows} Zeilen)</h3>
  <div style="max-height: 350px; overflow-y: auto; border: 1px solid #ddd; border-radius: 8px;">
    <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 13px;">
      <thead style="position: sticky; top: 0; background: #eee;">
        <tr>
          <th style="padding: 8px; border-bottom: 1px solid #ddd;">ID</th>
          <th style="padding: 8px; border-bottom: 1px solid #ddd;">1-Way Latenz</th>
          <th style="padding: 8px; border-bottom: 1px solid #ddd;">Jitter Status</th>
          <th style="padding: 8px; border-bottom: 1px solid #ddd;">Payload Last</th>
        </tr>
      </thead>
      <tbody>
        {#each messages.slice(0, domRows) as msg (msg.id)}
          <tr style="background-color: {msg.oneWayLatency > 5.0 ? '#fff0f0' : 'transparent'};">
            <td style="padding: 6px 8px; border-bottom: 1px solid #eee; font-weight: bold;">
              <span>#{msg.id}</span>
            </td>
            <td style="padding: 6px 8px; border-bottom: 1px solid #eee;">
              <span style="
                display: inline-block; padding: 2px 6px; border-radius: 4px;
                color: {msg.oneWayLatency > 5.0 ? '#d32f2f' : '#2e7d32'};
                background-color: {msg.oneWayLatency > 5.0 ? '#ffebee' : '#e8f5e9'};
                font-weight: bold;
              ">
                {msg.oneWayLatency} ms
              </span>
            </td>
            <td style="padding: 6px 8px; border-bottom: 1px solid #eee;">
              <div style="display: flex; align-items: center; gap: 6px;">
                <div style="
                  width: 8px; height: 8px; border-radius: 50%; 
                  background-color: {msg.jitter > 1.0 ? '#f57c00' : '#388e3c'};
                "></div>
                <span>{msg.jitter} ms</span>
              </div>
            </td>
            <td style="padding: 6px 8px; border-bottom: 1px solid #eee; color: #666;">
              <span style="font-size: 11px; padding: 1px 4px; background: #eee; border-radius: 3px;">
                {payloadSizeKb} KB ({payloadSizeKb * 1024} B)
              </span>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</main>