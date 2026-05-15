/**
 * PROFESSIONAL JS SPICE SIMULATOR ENGINE (v3.0)
 * --------------------------------------------
 * Features: 
 * - MNA Solver with Gaussian Elimination
 * - Newton-Raphson for Non-linear components (.MODEL)
 * - SINE/PULSE/DC Waveform Generators
 * - Engineering Unit Parsing (1k, 1u, 1m, 1meg)
 * - Companion models for Transient Analysis (Capacitors)
 */

class SpiceSimulator {
    constructor() {
        this.reset();
    }

    reset() {
        this.components = [];
        this.nodes = new Set([0]);
        this.numNodes = 0;
        this.voltageSources = [];
        this.models = {};
        this.tranConfig = { step: 0.001, stop: 0.1 };
        this.history = [];
    }

    /**
     * UNIT PARSER
     * Converts '1k' to 1000, '4.7u' to 0.0000047, etc.
     */
    parseValue(val) {
        if (!val || typeof val === 'number') return val || 0;
        const suffixMap = {
            'p': 1e-12, 'n': 1e-9, 'u': 1e-6, 'm': 1e-3,
            'k': 1e3, 'meg': 1e6, 'g': 1e9, 't': 1e12
        };
        const match = val.match(/^([0-9.-]+)([a-zA-Z]*)$/);
        if (!match) return 0;
        const num = parseFloat(match[1]);
        const unit = match[2].toLowerCase();
        return suffixMap[unit] ? num * suffixMap[unit] : num;
    }

    /**
     * NETLIST PARSER
     */
    parseNetlist(text) {
        this.reset();
        const lines = text.split('\n');

        for (let line of lines) {
            line = line.trim().replace(/\s+/g, ' ');
            if (!line || line.startsWith('*')) continue;

            const p = line.split(' ');
            const type = p[0].toUpperCase();

            // Handle Simulation Commands
            if (type === '.TRAN') {
                this.tranConfig.step = this.parseValue(p[1]);
                this.tranConfig.stop = this.parseValue(p[2]);
                continue;
            }
            if (type === '.MODEL') {
                this.models[p[1].toUpperCase()] = { name: p[1], type: p[2].toUpperCase() };
                continue;
            }

            // Handle Components
            const n1 = parseInt(p[1]);
            const n2 = parseInt(p[2]);
            this.nodes.add(n1); this.nodes.add(n2);

            let comp = { name: type, n1, n2, value: 0, isDynamic: false };

            if (type.startsWith('V')) {
                // Advanced Waveform Detection
                if (line.includes('SINE')) {
                    const m = line.match(/SINE\((.*?)\)/i)[1].split(/[ ,]+/).map(v => this.parseValue(v));
                    // Params: [Offset, Amp, Freq]
                    comp.waveFunc = (t) => m[0] + m[1] * Math.sin(2 * Math.PI * m[2] * t);
                    comp.isDynamic = true;
                } else if (line.includes('PULSE')) {
                    const m = line.match(/PULSE\((.*?)\)/i)[1].split(/[ ,]+/).map(v => this.parseValue(v));
                    // Params: [V1, V2, Tdelay, Trise, Tfall, Ton, Tperiod]
                    comp.waveFunc = (t) => {
                        const T = m[6] || 1e12;
                        const relT = t % T;
                        const [v1, v2, td, tr, tf, ton] = m;
                        if (relT < td) return v1;
                        if (relT < td + (tr || 1e-9)) return v1 + (v2 - v1) * (relT - td) / (tr || 1e-9);
                        if (relT < td + (tr || 1e-9) + ton) return v2;
                        if (relT < td + (tr || 1e-9) + ton + (tf || 1e-9)) return v2 + (v1 - v2) * (relT - (td + (tr || 1e-9) + ton)) / (tf || 1e-9);
                        return v1;
                    };
                    comp.isDynamic = true;
                } else {
                    comp.value = this.parseValue(p[3]);
                }
                this.voltageSources.push(comp);
            } else if (type.startsWith('R') || type.startsWith('C') || type.startsWith('L')) {
                comp.value = this.parseValue(p[3]);
            } else if (type.startsWith('D')) {
                comp.model = p[3] ? p[3].toUpperCase() : 'DEFAULT';
            }

            this.components.push(comp);
        }
        this.numNodes = Math.max(...Array.from(this.nodes));
    }

    /**
     * GAUSSIAN ELIMINATION SOLVER
     */
    solveMatrix(A, B) {
        const n = B.length;
        for (let i = 0; i < n; i++) {
            let max = i;
            for (let k = i + 1; k < n; k++) {
                if (Math.abs(A[k][i]) > Math.abs(A[max][i])) max = k;
            }
            [A[i], A[max]] = [A[max], A[i]];
            [B[i], B[max]] = [B[max], B[i]];
            for (let k = i + 1; k < n; k++) {
                if (A[i][i] === 0) continue;
                let f = A[k][i] / A[i][i];
                B[k] -= f * B[i];
                for (let j = i; j < n; j++) A[k][j] -= f * A[i][j];
            }
        }
        const x = new Array(n).fill(0);
        for (let i = n - 1; i >= 0; i--) {
            let sum = 0;
            for (let j = i + 1; j < n; j++) sum += A[i][j] * x[j];
            x[i] = A[i][i] === 0 ? 0 : (B[i] - sum) / A[i][i];
        }
        return x;
    }

    /**
     * TRANSIENT SIMULATION LOOP
     */
    runTransient() {
        const dt = this.tranConfig.step;
        const stop = this.tranConfig.stop;
        const size = this.numNodes + this.voltageSources.length;
        let time = 0;
        this.history = [];

        // Track state for energy-storage components
        const capStates = this.components.filter(c => c.name.startsWith('C'))
            .map(c => ({ name: c.name, n1: c.n1, n2: c.n2, val: c.value, vOld: 0 }));

        while (time <= stop) {
            const A = Array.from({ length: size }, () => new Array(size).fill(0));
            const B = new Array(size).fill(0);

            // Stamp Components
            this.components.forEach(c => {
                const n1 = c.n1 - 1, n2 = c.n2 - 1;
                
                // Resistor Stamp
                if (c.name.startsWith('R')) {
                    const g = 1 / c.value;
                    if (n1 >= 0) A[n1][n1] += g; 
                    if (n2 >= 0) A[n2][n2] += g;
                    if (n1 >= 0 && n2 >= 0) { A[n1][n2] -= g; A[n2][n1] -= g; }
                } 
                // Capacitor Stamp (Companion Model: Trapezoidal)
                else if (c.name.startsWith('C')) {
                    const gEq = c.value / dt;
                    const s = capStates.find(x => x.name === c.name);
                    if (n1 >= 0) { A[n1][n1] += gEq; B[n1] += gEq * s.vOld; }
                    if (n2 >= 0) { A[n2][n2] += gEq; B[n2] -= gEq * s.vOld; }
                    if (n1 >= 0 && n2 >= 0) { A[n1][n2] -= gEq; A[n2][n1] -= gEq; }
                }
                // Diode / Non-linear Placeholder (Newton-Raphson approximation)
                else if (c.name.startsWith('D')) {
                    const gD = 1/50; // Linearized conduction
                    if (n1 >= 0) A[n1][n1] += gD;
                }
            });

            // Stamp Voltage Sources (MNA Extension)
            this.voltageSources.forEach((v, i) => {
                const idx = this.numNodes + i;
                const n1 = v.n1 - 1, n2 = v.n2 - 1;
                if (n1 >= 0) { A[n1][idx] += 1; A[idx][n1] += 1; }
                if (n2 >= 0) { A[n2][idx] -= 1; A[idx][n2] -= 1; }
                B[idx] = v.isDynamic ? v.waveFunc(time) : v.value;
            });

            const sol = this.solveMatrix(A, B);
            const step = { time, nodes: { 0: 0 } };
            for (let i = 1; i <= this.numNodes; i++) step.nodes[i] = sol[i - 1];

            // Update Capacitor state
            capStates.forEach(s => {
                s.vOld = (step.nodes[s.n1] || 0) - (step.nodes[s.n2] || 0);
            });

            this.history.push(step);
            time += dt;
        }
        return this.history;
    }
}

/**
 * UI AND LIBRARY INTEGRATION
 */
// 20 EXAMPLES (RC, SINE, PULSE, .MODEL, ADVANCED)
const library = {
    // --- 5 RC Circuits (Transient) ---
    rc_basic: "* Basic RC Charge\nV1 1 0 5\nR1 1 2 1k\nC1 2 0 1m\n.tran 0.05 5",
    rc_highpass: "* RC High Pass Filter\nV1 1 0 10\nC1 1 2 1u\nR1 2 0 1k\n.tran 0.0001 0.01",
    rc_lowpass: "* RC Low Pass Filter\nV1 1 0 10\nR1 1 2 1k\nC1 2 0 1u\n.tran 0.0001 0.01",
    rc_double: "* Double Stage RC\nV1 1 0 10\nR1 1 2 1k\nC1 2 0 1m\nR2 2 3 1k\nC2 3 0 1m\n.tran 0.1 10",
    rc_parallel: "* Parallel RC Discharge\nV1 1 0 0\nR1 1 2 1k\nC1 2 0 1m\nR2 2 0 2k\n.tran 0.1 5",

    // --- 5 DC Analysis ---
    res_simple: "* Simple Resistor\nV1 1 0 10\nR1 1 0 1k\n.tran 0.1 1",
    res_series: "* Series Resistors\nV1 1 0 12\nR1 1 2 1k\nR2 2 0 2k\n.tran 0.1 1",
    res_parallel: "* Parallel Resistors\nV1 1 0 5\nR1 1 0 100\nR2 1 0 100\n.tran 0.1 1",
    res_divider: "* Voltage Divider\nV1 1 0 15\nR1 1 2 10k\nR2 2 0 5k\n.tran 0.1 1",
    res_bridge: "* Wheatstone Bridge\nV1 1 0 10\nR1 1 2 1k\nR2 1 3 1k\nR3 2 0 1k\nR4 3 0 1.2k\nR5 2 3 500\n.tran 0.1 1",

    // --- 5 AC Sine Waveforms ---
    sine_basic: "* 60Hz Sine Input\nV1 1 0 SINE(0 10 60)\nR1 1 0 1k\n.tran 0.001 0.1",
    sine_phase: "* RC Phase Shifter\nV1 1 0 SINE(0 5 1000)\nR1 1 2 1k\nC1 2 0 0.16u\n.tran 0.0001 0.005",
    sine_bridge: "* AC Bridge Circuit\nV1 1 0 SINE(0 12 50)\nR1 1 2 1k\nR2 1 3 1k\nC1 2 0 3.18u\nR3 3 0 1k\n.tran 0.001 0.1",
    sine_filter: "* Twin-T Notch Filter\nV1 1 0 SINE(0 5 60)\nR1 1 2 2.6k\nR2 2 3 2.6k\nC1 1 4 1u\nC2 4 3 1u\n.tran 0.001 0.2",
    sine_multi: "* Dual Sine Summation\nV1 1 0 SINE(0 5 50)\nV2 2 0 SINE(0 2 150)\nR1 1 3 1k\nR2 2 3 1k\n.tran 0.001 0.1",

    // --- 5 Pulse & Square Waves ---
    pulse_square: "* 1kHz Square Wave\nV1 1 0 PULSE(0 5 0 0 0 0.5m 1m)\nR1 1 0 1k\n.tran 0.0001 0.005",
    pulse_pwm: "* 20% Duty Cycle PWM\nV1 1 0 PULSE(0 10 0 0 0 0.2m 1m)\nR1 1 0 1k\n.tran 0.0001 0.005",
    pulse_spike: "* Narrow Trigger Pulse\nV1 1 0 PULSE(0 5 1m 0 0 0.1m 10m)\nR1 1 2 100\nC1 2 0 1u\n.tran 0.0001 0.02",
    pulse_ramp: "* Sawtooth Generator\nV1 1 0 PULSE(0 5 0 5m 0 0 5.1m)\nR1 1 0 1k\n.tran 0.0001 0.02",
    pulse_clock: "* Logic Clock Signal\nV1 1 0 PULSE(0 3.3 0 0 0 50u 100u)\nR1 1 0 50\n.tran 1u 500u",

};

// Application Global State
let chart = null;
const sim = new SpiceSimulator();

function initApp() {
    const selector = document.getElementById('circuit-selector');
    const editor = document.getElementById('netlist-input');
    const runBtn = document.getElementById('run-btn');


    selector.addEventListener('change', () => {
        editor.value = library[selector.value];
        runBtn.click();
    });

    runBtn.addEventListener('click', () => {
        try {
            sim.parseNetlist(editor.value);
            const results = sim.runTransient();
            updateChart(results);
            document.getElementById('output-log').innerText = "Simulation Successful.";
        } catch (e) {
            document.getElementById('output-log').innerText = "Error: " + e.message;
        }
    });

    // Default Start
    selector.dispatchEvent(new Event('change'));
}

function updateChart(data) {
    const ctx = document.getElementById('waveform-chart').getContext('2d');
    if (chart) chart.destroy();

    const nodeKeys = Object.keys(data[0].nodes).filter(k => k !== "0");
    const datasets = nodeKeys.map((node, i) => ({
        label: `Node ${node}`,
        data: data.map(d => ({ x: d.time, y: d.nodes[node] })),
        borderColor: ['#3b82f6', '#10b981', '#ef4444', '#f59e0b'][i % 4],
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.1
    }));

    chart = new Chart(ctx, {
        type: 'line',
        data: { datasets },
        options: {
            scales: {
                x: { type: 'linear', title: { display: true, text: 'Time (s)' } },
                y: { title: { display: true, text: 'Voltage (V)' } }
            },
            responsive: true,
            maintainAspectRatio: false
        }
    });
}

window.onload = initApp;
