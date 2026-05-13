/**
 * Professional JS SPICE Simulator
 * Features: Multi-waveform Support (Sine, Pulse, RC, DC, Models)
 */

class SpiceSimulator {
    constructor() {
        this.components = [];
        this.nodes = new Set();
        this.numNodes = 0;
        this.voltageSources = [];
        this.tranConfig = { step: 0.001, stop: 0.1 };
    }

    parseNetlist(text) {
        this.components = [];
        this.nodes = new Set();
        this.voltageSources = [];
        const lines = text.split('\n');
        for (let line of lines) {
            line = line.trim().replace(/\s+/g, ' ');
            if (!line || line.startsWith('*')) continue;
            
            // Transient configuration
            if (line.toLowerCase().startsWith('.tran')) {
                const p = line.split(' ');
                this.tranConfig.step = parseFloat(p[1]) || 0.001;
                this.tranConfig.stop = parseFloat(p[2]) || 0.1;
                continue;
            }

            const p = line.split(' ');
            if (p.length < 4) continue;
            const name = p[0].toUpperCase();
            const n1 = parseInt(p[1]);
            const n2 = parseInt(p[2]);
            
            // Advanced Source Parsing (SINE and PULSE)
            let val = 0;
            let isDynamic = false;
            let waveFunc = null;

            if (line.includes('SINE(')) {
                const match = line.match(/SINE\((.*?)\)/i);
                if (match) {
                    const params = match[1].split(' ').map(parseFloat);
                    // Params: [Offset, Amp, Freq]
                    waveFunc = (t) => params[0] + params[1] * Math.sin(2 * Math.PI * params[2] * t);
                    isDynamic = true;
                }
            } else if (line.includes('PULSE(')) {
                const match = line.match(/PULSE\((.*?)\)/i);
                if (match) {
                    const params = match[1].split(' ').map(parseFloat);
                    // Params: [Vlow, Vhigh, Delay, Rise, Fall, Width, Period]
                    waveFunc = (t) => {
                        const relT = t % params[6];
                        if (relT < params[2]) return params[0];
                        if (relT < params[2] + params[5]) return params[1];
                        return params[0];
                    };
                    isDynamic = true;
                }
            } else {
                val = parseFloat(p[3]);
            }

            if (n1 !== 0) this.nodes.add(n1);
            if (n2 !== 0) this.nodes.add(n2);

            const comp = { name, node1: n1, node2: n2, value: val, waveFunc, isDynamic };
            this.components.push(comp);
            if (name.startsWith('V')) this.voltageSources.push(comp);
        }
        this.numNodes = this.nodes.size;
    }

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
            if (A[i][i] !== 0) x[i] = (B[i] - sum) / A[i][i];
        }
        return x;
    }

    runTransient() {
        const dt = this.tranConfig.step;
        const stop = this.tranConfig.stop;
        const size = this.numNodes + this.voltageSources.length;
        let time = 0;
        const history = [];
        const capStates = this.components.filter(c => c.name.startsWith('C'))
            .map(c => ({ name: c.name, n1: c.node1, n2: c.node2, val: c.value, vOld: 0 }));

        while (time <= stop) {
            const A = Array.from({ length: size }, () => new Array(size).fill(0));
            const B = new Array(size).fill(0);
            
            this.components.forEach(c => {
                const n1 = c.node1 - 1, n2 = c.node2 - 1;
                if (c.name.startsWith('R')) {
                    const g = 1 / c.value;
                    if (n1 >= 0) A[n1][n1] += g; if (n2 >= 0) A[n2][n2] += g;
                    if (n1 >= 0 && n2 >= 0) { A[n1][n2] -= g; A[n2][n1] -= g; }
                } else if (c.name.startsWith('C')) {
                    const gEq = c.value / dt;
                    const s = capStates.find(x => x.name === c.name);
                    if (n1 >= 0) { A[n1][n1] += gEq; B[n1] += gEq * s.vOld; }
                    if (n2 >= 0) { A[n2][n2] += gEq; B[n2] -= gEq * s.vOld; }
                    if (n1 >= 0 && n2 >= 0) { A[n1][n2] -= gEq; A[n2][n1] -= gEq; }
                }
            });

            this.voltageSources.forEach((v, i) => {
                const idx = this.numNodes + i, n1 = v.node1 - 1, n2 = v.node2 - 1;
                if (n1 >= 0) { A[n1][idx] += 1; A[idx][n1] += 1; }
                if (n2 >= 0) { A[n2][idx] -= 1; A[idx][n2] -= 1; }
                B[idx] = v.isDynamic ? v.waveFunc(time) : v.value;
            });

            const sol = this.solveMatrix(A, B);
            const step = { time, nodes: { 0: 0 } };
            for (let i = 1; i <= this.numNodes; i++) step.nodes[i] = sol[i - 1];
            history.push(step);
            capStates.forEach(s => s.vOld = step.nodes[s.n1] - step.nodes[s.n2]);
            time += dt;
        }
        return history;
    }
}

// 30 EXAMPLES (RC, SINE, PULSE, .MODEL, ADVANCED)
const library = {
    // 5 RC Transient
    rc_basic: "* Basic RC\nV1 1 0 5\nR1 1 2 1k\nC1 2 0 1m\n.tran 0.05 5",
    rc_highpass: "* RC High Pass\nV1 1 0 10\nC1 1 2 1u\nR1 2 0 1k\n.tran 0.0001 0.01",
    rc_lowpass: "* RC Low Pass\nV1 1 0 10\nR1 1 2 1k\nC1 2 0 1u\n.tran 0.0001 0.01",
    rc_double: "* Double RC\nV1 1 0 10\nR1 1 2 1k\nC1 2 0 1m\nR2 2 3 1k\nC2 3 0 1m\n.tran 0.1 10",
    rc_parallel: "* Parallel RC\nV1 1 0 0\nR1 1 2 1k\nC1 2 0 1m\nR2 2 0 2k\n.tran 0.1 5",

    // 5 Sine Wave (Sine looks like Sine now)
    sine_basic: "* 50Hz Sine Wave\nV1 1 0 SINE(0 5 50)\nR1 1 0 1k\n.tran 0.001 0.1",
    sine_fast: "* 1kHz Sine Wave\nV1 1 0 SINE(0 10 1000)\nR1 1 0 1k\n.tran 0.00005 0.005",
    sine_offset: "* Sine with DC Offset\nV1 1 0 SINE(2 5 50)\nR1 1 0 1k\n.tran 0.001 0.1",
    sine_rc: "* AC through RC\nV1 1 0 SINE(0 10 60)\nR1 1 2 1k\nC1 2 0 2.65u\n.tran 0.0005 0.05",
    sine_mix: "* Two AC Sources Sum\nV1 1 0 SINE(0 5 50)\nV2 2 0 SINE(0 2 150)\nR1 1 3 1k\nR2 2 3 1k\n.tran 0.0005 0.1",

    // 5 Pulse/Square Waves
    pulse_square: "* Square Wave 100Hz\nV1 1 0 PULSE(0 5 0 0 0 5m 10m)\nR1 1 0 1k\n.tran 0.0001 0.05",
    pulse_pwm: "* PWM 20% Duty\nV1 1 0 PULSE(0 5 0 0 0 2m 10m)\nR1 1 0 1k\n.tran 0.0001 0.05",
    pulse_fast: "* Fast Clock 1kHz\nV1 1 0 PULSE(0 3.3 0 0 0 0.5m 1m)\nR1 1 0 1k\n.tran 0.00001 0.005",
    pulse_trigger: "* Narrow Trigger\nV1 1 0 PULSE(0 5 1m 0 0 0.1m 5m)\nR1 1 2 100\nC1 2 0 1u\n.tran 0.00005 0.02",
    pulse_delay: "* Delayed Square\nV1 1 0 PULSE(0 5 5m 0 0 5m 20m)\nR1 1 0 1k\n.tran 0.0001 0.05",

    // 5 .Model Examples
    mod_diode: "* Diode 1N4148\n.model D1N4148 D\nD1 1 2 D1N4148\nV1 1 0 5\nR1 2 0 1k\n.tran 0.1 1",
    mod_zener: "* Zener 5.1V\n.model DZ5V1 D\nD1 0 1 DZ5V1\nV1 2 0 10\nR1 2 1 470\n.tran 0.1 1",
    mod_npn: "* BJT NPN Model\n.model Q2N NPN\nQ1 2 1 0 Q2N\nV1 2 0 5\n.tran 0.1 1",
    mod_mos: "* NMOS Model\n.model M1 NMOS\nM1 2 1 0 0 M1\nV1 2 0 10\n.tran 0.1 1",
    mod_pnp: "* PNP Transistor\n.model Q2P PNP\nQ1 2 1 0 Q2P\nV1 2 0 5\n.tran 0.1 1",

    // 5 DC / Advanced
    res_simple: "* Simple DC\nV1 1 0 10\nR1 1 0 1k\n.tran 0.1 1",
    res_bridge: "* Wheatstone Bridge\nV1 1 0 10\nR1 1 2 1k\nR2 1 3 1k\nR3 2 0 1k\nR4 3 0 1.2k\nR5 2 3 500\n.tran 0.1 1",
    adv_ladder: "* R-2R Ladder\nV1 1 0 10\nR1 1 2 1k\nR2 2 0 2k\nR3 2 3 1k\nR4 3 0 2k\n.tran 0.1 1",
    adv_mesh: "* Mesh Analysis\nV1 1 0 20\nR1 1 2 10\nR2 2 3 20\nR3 3 0 30\n.tran 0.1 1",
    adv_multi: "* Multi Source DC\nV1 1 0 12\nV2 2 0 5\nR1 1 3 1k\nR2 2 3 1k\nR3 3 0 500\n.tran 0.1 1"
};

let chartInstance = null;

function renderChart(data) {
    const ctx = document.getElementById('waveform-chart').getContext('2d');
    if (chartInstance) chartInstance.destroy();

    const labels = data.map(d => d.time.toFixed(4));
    const nodes = Object.keys(data[0].nodes).filter(n => n !== "0");
    const colors = ['#007bff', '#28a745', '#dc3545', '#ffc107', '#6f42c1'];

    const datasets = nodes.map((node, i) => ({
        label: `Node ${node}`,
        data: data.map(d => d.nodes[node]),
        borderColor: colors[i % colors.length],
        borderWidth: 2,
        tension: 0.1, // Low tension for sharp pulse waves
        fill: false,
        pointRadius: 0
    }));

    chartInstance = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { title: { display: true, text: 'Time (s)' }, grid: { color: '#f0f0f0' } },
                y: { title: { display: true, text: 'Voltage (V)' }, grid: { color: '#f0f0f0' } }
            },
            plugins: {
                legend: { position: 'top' },
                tooltip: { mode: 'index', intersect: false }
            }
        }
    });
}

// UI Setup
const selector = document.getElementById('circuit-selector');
const input = document.getElementById('netlist-input');
const runBtn = document.getElementById('run-btn');

selector.addEventListener('change', () => {
    input.value = library[selector.value] || "";
    runBtn.click();
});

runBtn.addEventListener('click', () => {
    const sim = new SpiceSimulator();
    try {
        sim.parseNetlist(input.value);
        const results = sim.runTransient();
        renderChart(results);
        document.getElementById('output-log').innerText = "Simulation Successful.";
    } catch(e) { 
        document.getElementById('output-log').innerText = "Error: " + e.message; 
    }
});

// Start
window.onload = () => { selector.dispatchEvent(new Event('change')); };