import React, { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect } from 'react';
import { flushSync } from 'react-dom';
import mqtt from 'mqtt';
import { Chart, registerables } from 'chart.js';

Chart.register(...registerables);

// --- CONFIGURATION ---
const SERVER_IP = '192.168.0.208'; 
const WS_PORT = '1880';          
const MQTT_WS_PORT = '9001';     

export default function App() {
  // 1. Unabhängige Variablen (Szenarien & Parameter)
  const [protocol, setProtocol] = useState('ws');
  const [frequencyHz, setFrequencyHz] = useState(10); // 10, 50, 200 Hz
  const [domRows, setDomRows] = useState(50);         // 10, 50, 100, 1000 Zeilen
  const [payloadSizeKb, setPayloadSizeKb] = useState(1); // 0.1, 1, 10 KB

  // Dynamische Erzeugung der Payload-Bytes (Memoisiert für Memory-Effizienz)
  const dummyPayload = useMemo(() => {
    return 'A'.repeat(Math.round(payloadSizeKb * 1024));
  }, [payloadSizeKb]);

  // 2. Netzwerk & Telemetrie States
  const [isConnected, setIsConnected] = useState(false);
  const [messages, setMessages] = useState([]);
  const [fps, setFps] = useState(0);
  const [processingTime, setProcessingTime] = useState(0);
  const [throughput, setThroughput] = useState(0); 

  // 3. Benchmark States
  const [isBenchmarking, setIsBenchmarking] = useState(false);
  const [benchmarkTimeLeft, setBenchmarkTimeLeft] = useState(0);
  const [benchmarkResult, setBenchmarkResult] = useState(null);

  // 4. Refs für stabile Lebenszyklen und Zeitmessung
  const canvasRef = useRef(null);
  const chartInstanceRef = useRef(null);
  const packetIdCounter = useRef(0);
  const lastPacketTimestamp = useRef(performance.now());
  const receivedBytesInSecond = useRef(0);
  
  const wsClientRef = useRef(null);
  const mqttClientRef = useRef(null);
  const sendIntervalRef = useRef(null);

  // Refs für die exakte vDOM-Zeitmessung
  const packetProcessStartRef = useRef(0);
  const latestProcTimeRef = useRef(0);

  // Refs für den Benchmark-Collector
  const isBenchmarkingRef = useRef(false);
  const benchmarkDataRef = useRef({ latencies: [], processingTimes: [], fpsList: [], packetsReceived: 0 });

  // --- FPS COUNTER ---
  useEffect(() => {
    let frameCount = 0;
    let lastTime = performance.now();
    let animationFrameId;

    const calcFPS = () => {
      const now = performance.now();
      frameCount++;
      if (now - lastTime >= 1000) {
        setFps(frameCount);
        if (isBenchmarkingRef.current) {
          benchmarkDataRef.current.fpsList.push(frameCount);
        }
        frameCount = 0;
        lastTime = now;
      }
      animationFrameId = requestAnimationFrame(calcFPS);
    };

    animationFrameId = requestAnimationFrame(calcFPS);
    return () => cancelAnimationFrame(animationFrameId);
  }, []);

  // --- THROUGHPUT CALCULATOR ---
  useEffect(() => {
    const tpInterval = setInterval(() => {
      setThroughput((receivedBytesInSecond.current / 1024).toFixed(2));
      receivedBytesInSecond.current = 0;
    }, 1000);
    return () => clearInterval(tpInterval);
  }, []);

  // --- MULTI-TRACE CHART INITIALISIERUNG (3 Spuren) ---
  const initChart = useCallback(() => {
    if (chartInstanceRef.current) chartInstanceRef.current.destroy();
    if (!canvasRef.current) return;

    chartInstanceRef.current = new Chart(canvasRef.current, {
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
  }, []);

  const updateChart = (currentMessages) => {
    if (!chartInstanceRef.current) return;
    const reversed = currentMessages.slice(0, 100).reverse();
    chartInstanceRef.current.data.labels = reversed.map((m) => `#${m.id}`);
    chartInstanceRef.current.data.datasets[0].data = reversed.map((m) => m.oneWayLatency);
    chartInstanceRef.current.data.datasets[1].data = reversed.map((m) => m.jitter);
    chartInstanceRef.current.data.datasets[2].data = reversed.map((m) => m.procTime);
    chartInstanceRef.current.update();
  };

  // --- NETZWERK & MELDUNGSVERARBEITUNG ---
  const sendPing = (sendFn) => {
    packetIdCounter.current += 1;
    const packet = { id: packetIdCounter.current, sendTimestamp: performance.now(), payload: dummyPayload };
    sendFn(JSON.stringify(packet));
  };

  const handlePong = useCallback((rawMessage) => {
    // STARTZEITPUNKT erfassen.
    if (packetProcessStartRef.current === 0) {
      packetProcessStartRef.current = performance.now();
    }
    
    const receiveTimestamp = performance.now();
    receivedBytesInSecond.current += rawMessage.length;
    
    // JSON Parsing (CPU Last)
    const data = JSON.parse(rawMessage);
    
    // Latenz & Jitter berechnen
    const rtt = receiveTimestamp - data.sendTimestamp;
    const oneWayLatency = parseFloat((rtt / 2).toFixed(3));

    const prevLatency = lastPacketTimestamp.current ? lastPacketTimestamp.current : oneWayLatency;
    const currentJitter = parseFloat(Math.abs(oneWayLatency - prevLatency).toFixed(3));
    lastPacketTimestamp.current = oneWayLatency;

    // Rohdaten-Sammlung (Latenz und Paketverlust)
    if (isBenchmarkingRef.current) {
      benchmarkDataRef.current.latencies.push(oneWayLatency);
      benchmarkDataRef.current.packetsReceived += 1;
    }

    // --- NEU: flushSync erzwingt das sofortige synchrone Rendering (kein Batching!) ---
    flushSync(() => {
      setMessages((prevMessages) => {
        const updated = [
          { 
            id: data.id, 
            oneWayLatency, 
            rtt: parseFloat(rtt.toFixed(3)), 
            jitter: currentJitter, 
            procTime: latestProcTimeRef.current // Letzte bekannte Scripting Time für das Chart
          }, 
          ...prevMessages.slice(0, 999)
        ];
        updateChart(updated);
        return updated;
      });
    });
  }, []);

  // --- VIRTUAL DOM MESSUNG (Commit-Phase) ---
  useLayoutEffect(() => {
    // Wird synchron aufgerufen, nachdem React das DOM mutiert hat, aber BEVOR der Browser malt.
    if (packetProcessStartRef.current !== 0) {
      const renderEnd = performance.now();
      const trueRenderTime = parseFloat((renderEnd - packetProcessStartRef.current).toFixed(3));
      
      latestProcTimeRef.current = trueRenderTime;
      setProcessingTime(trueRenderTime); // Anzeige im UI aktualisieren
      
      if (isBenchmarkingRef.current) {
        benchmarkDataRef.current.processingTimes.push(trueRenderTime);
      }
      
      // Timer für das nächste Paket zurücksetzen
      packetProcessStartRef.current = 0; 
    }
  });

  const disconnect = useCallback(() => {
    if (sendIntervalRef.current) clearInterval(sendIntervalRef.current);
    if (wsClientRef.current) wsClientRef.current.close();
    if (mqttClientRef.current) mqttClientRef.current.end();
    setIsConnected(false);
  }, []);

  const connect = useCallback(() => {
    disconnect();
    setMessages([]);
    packetIdCounter.current = 0;
    initChart();
    const pingIntervalMs = 1000 / frequencyHz;

    if (protocol === 'ws') {
      const ws = new WebSocket(`ws://${SERVER_IP}:${WS_PORT}/ws/benchmark`);
      wsClientRef.current = ws;
      ws.onopen = () => {
        setIsConnected(true);
        sendIntervalRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) sendPing((msg) => ws.send(msg));
        }, pingIntervalMs);
      };
      ws.onclose = () => setIsConnected(false);
      ws.onmessage = (event) => handlePong(event.data);
    } else if (protocol === 'mqtt') {
      const client = mqtt.connect(`ws://${SERVER_IP}:${MQTT_WS_PORT}`);
      mqttClientRef.current = client;
      client.on('connect', () => {
        setIsConnected(true);
        client.subscribe('benchmark/pong');
        sendIntervalRef.current = setInterval(() => {
          if (client.connected) sendPing((msg) => client.publish('benchmark/ping', msg));
        }, pingIntervalMs);
      });
      client.on('offline', () => setIsConnected(false));
      client.on('message', (topic, message) => handlePong(message.toString()));
    }
  }, [protocol, frequencyHz, payloadSizeKb, disconnect, initChart, handlePong]);

  useEffect(() => {
    connect();
    return () => { disconnect(); if (chartInstanceRef.current) chartInstanceRef.current.destroy(); };
  }, [connect, disconnect]);

  // --- BENCHMARK LOGIC ---
  const runBenchmark = () => {
    setBenchmarkResult(null);
    setIsBenchmarking(true);
    isBenchmarkingRef.current = true;
    benchmarkDataRef.current = { latencies: [], processingTimes: [], fpsList: [], packetsReceived: 0 };
    
    setBenchmarkTimeLeft(60);
    
    const countdown = setInterval(() => {
      setBenchmarkTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(countdown);
          finishBenchmark();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const finishBenchmark = () => {
    setIsBenchmarking(false);
    isBenchmarkingRef.current = false;

    const { latencies, processingTimes, fpsList, packetsReceived } = benchmarkDataRef.current;
    
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

    const report = {
      config: { framework: 'React', protocol, frequencyHz, domRows, payloadSizeKb: `${payloadSizeKb} KB`, duration: '60s' },
      latency: calcAggregates(latencies),
      scriptingTime: calcAggregates(processingTimes),
      fps: calcAggregates(fpsList),
      packetLoss: `${lossRate}% (${packetsReceived}/${expectedPackets})`
    };

    setBenchmarkResult(report);
  };

  return (
    <main style={{ fontFamily: 'sans-serif', padding: '20px', maxWidth: '1050px', margin: '0 auto' }}>
      <h1>React Telemetry Benchmark</h1>

      {/* --- KONTROLLZENTRUM --- */}
      <div style={{ padding: '15px', background: '#f5f5f5', borderRadius: '8px', marginBottom: '20px', display: 'flex', flexWrap: 'wrap', gap: '15px', alignItems: 'center' }}>
        <div>
          <strong>Protokoll: </strong>
          <select value={protocol} onChange={(e) => setProtocol(e.target.value)} disabled={isBenchmarking}>
            <option value="ws">Native WS</option>
            <option value="mqtt">MQTT over WS</option>
          </select>
        </div>
        <div>
          <strong>Frequenz: </strong>
          <select value={frequencyHz} onChange={(e) => setFrequencyHz(Number(e.target.value))} disabled={isBenchmarking}>
            <option value={10}>10 Hz (Baseline)</option>
            <option value={50}>50 Hz (Real-Time)</option>
            <option value={200}>200 Hz (Stress Test)</option>
          </select>
        </div>
        <div>
          <strong>DOM-Last: </strong>
          <select value={domRows} onChange={(e) => setDomRows(Number(e.target.value))} disabled={isBenchmarking}>
            <option value={10}>10 Zeilen</option>
            <option value={50}>50 Zeilen</option>
            <option value={100}>100 Zeilen</option>
            <option value={500}>500 Zeilen (Extrem)</option>
          </select>
        </div>
        <div>
          <strong>Payload: </strong>
          <select value={payloadSizeKb} onChange={(e) => setPayloadSizeKb(Number(e.target.value))} disabled={isBenchmarking}>
            <option value={0.1}>100 Bytes</option>
            <option value={1}>1 KB</option>
            <option value={10}>10 KB</option>
            <option value={100}>100 KB</option>
          </select>
        </div>
        
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '10px', alignItems: 'center' }}>
          <span style={{ color: isConnected ? 'green' : 'red', fontWeight: 'bold' }}>{isConnected ? '● Verbunden' : '● Getrennt'}</span>
          <button 
            onClick={runBenchmark} 
            disabled={!isConnected || isBenchmarking}
            style={{ background: isBenchmarking ? '#ccc' : '#e63946', color: '#fff', padding: '10px 15px', border: 'none', borderRadius: '5px', fontWeight: 'bold', cursor: isBenchmarking ? 'not-allowed' : 'pointer' }}>
            {isBenchmarking ? `Benchmark läuft... (${benchmarkTimeLeft}s)` : 'Start 60s Benchmark'}
          </button>
        </div>
      </div>

      {/* --- BENCHMARK REPORT MODAL --- */}
      {benchmarkResult && (
        <div style={{ padding: '20px', background: '#e3f2fd', border: '1px solid #90caf9', borderRadius: '8px', marginBottom: '20px' }}>
          <h2 style={{ margin: '0 0 10px 0', color: '#1565c0' }}>Benchmark Abgeschlossen (React)</h2>
          <textarea 
            readOnly 
            value={JSON.stringify(benchmarkResult, null, 2)} 
            style={{ width: '100%', height: '220px', fontFamily: 'monospace', fontSize: '13px', padding: '10px' }}
          />
        </div>
      )}

      {/* --- LIVE KPIs --- */}
      <div style={{ display: 'flex', gap: '15px', fontSize: '14px', background: '#e0e0e0', padding: '10px 15px', borderRadius: '6px', marginBottom: '20px' }}>
        <div>UI Frame Rate: <strong style={{ color: fps < (frequencyHz === 200 ? 100 : 45) ? 'red' : 'green' }}>{fps} FPS</strong></div>
        <div>Processing Time: <strong>{processingTime} ms</strong></div>
        <div>Throughput: <strong>{throughput} KB/s</strong></div>
      </div>

      {/* Multi-Trace Diagramm */}
      <div style={{ marginBottom: '20px', padding: '15px', border: '1px solid #ddd', borderRadius: '8px', height: '300px' }}>
        <canvas ref={canvasRef}></canvas>
      </div>

      {/* --- COMPLEX DOM TABLE --- */}
      <h3>Telemetrie-Historie (Erweiterte DOM-Struktur: {domRows} Zeilen)</h3>
      <div style={{ maxHeight: '350px', overflowY: 'auto', border: '1px solid #ddd', borderRadius: '8px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
          <thead style={{ position: 'sticky', top: 0, background: '#eee' }}>
            <tr>
              <th style={{ padding: '8px', borderBottom: '1px solid #ddd' }}>ID</th>
              <th style={{ padding: '8px', borderBottom: '1px solid #ddd' }}>1-Way Latenz</th>
              <th style={{ padding: '8px', borderBottom: '1px solid #ddd' }}>Jitter Status</th>
              <th style={{ padding: '8px', borderBottom: '1px solid #ddd' }}>Payload Last</th>
            </tr>
          </thead>
          <tbody>
            {messages.slice(0, domRows).map((msg) => {
              const isCritical = msg.oneWayLatency > 5.0;
              const isHighJitter = msg.jitter > 1.0;
              
              return (
                <tr key={msg.id} style={{ backgroundColor: isCritical ? '#fff0f0' : 'transparent' }}>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid #eee', fontWeight: 'bold' }}>
                    <span>#{msg.id}</span>
                  </td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid #eee' }}>
                    <span style={{ 
                      display: 'inline-block', padding: '2px 6px', borderRadius: '4px',
                      color: isCritical ? '#d32f2f' : '#2e7d32',
                      backgroundColor: isCritical ? '#ffebee' : '#e8f5e9',
                      fontWeight: 'bold' 
                    }}>
                      {msg.oneWayLatency} ms
                    </span>
                  </td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid #eee' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <div style={{ 
                        width: '8px', height: '8px', borderRadius: '50%', 
                        backgroundColor: isHighJitter ? '#f57c00' : '#388e3c' 
                      }}></div>
                      <span>{msg.jitter} ms</span>
                    </div>
                  </td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid #eee', color: '#666' }}>
                    <span style={{ fontSize: '11px', padding: '1px 4px', background: '#eee', borderRadius: '3px' }}>
                      {payloadSizeKb} KB ({payloadSizeKb * 1024} B)
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}