'use strict';

const utils = require('@iobroker/adapter-core');

class VirtualWb extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'virtualwb',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        this.log.info('virtualWB Adapter gestartet (inkl. openWB 1.9 Regellogik & Speicher-Beachtung)!');

        this.subscribeStates('control.chargeMode');

        this.interval = setInterval(() => {
            this.runControlLoop();
        }, 10000);
    }

    async runControlLoop() {
        try {
            const modeState = await this.getStateAsync('control.chargeMode');
            if (!modeState) return;
            const chargeMode = modeState.val;

            let evuPower = 0; // W (+ Bezug, - Einspeisung)
            let pvPower = 0;  // W
            let batSoc = 100; // %
            let currentPrice = 0.0; // EUR/kWh

            if (this.config.evuState) {
                const s = await this.getStateAsync(this.config.evuState);
                if (s && typeof s.val === 'number') evuPower = s.val;
            }
            if (this.config.pvState) {
                const s = await this.getStateAsync(this.config.pvState);
                if (s && typeof s.val === 'number') pvPower = s.val;
            }
            if (this.config.batSocState) {
                const s = await this.getStateAsync(this.config.batSocState);
                if (s && typeof s.val === 'number') batSoc = s.val;
            }
            if (this.config.priceState) {
                const s = await this.getStateAsync(this.config.priceState);
                if (s && typeof s.val === 'number') currentPrice = s.val;
            }

            // Optional 70% Regelung Berücksichtigung
            let effectiveEvuPower = evuPower;
            if (this.config.pv_rule70 && chargeMode === 3) {
                const rulePoint = parseFloat(this.config.pv_rule70_point) || 9000;
                if (pvPower > rulePoint) {
                    // Wenn PV über 70% Abregelungspunkt ist, virtuell anpassen
                    effectiveEvuPower -= (pvPower - rulePoint);
                }
            }

            const numCP = parseInt(this.config.numChargingPoints, 10) || 2;
            const cpTargets = {};

            for (let i = 1; i <= 4; i++) {
                const enabled = this.config[`cp${i}_enabled`];
                const writeState = this.config[`cp${i}_writeState`];

                if (i <= numCP && enabled && writeState) {
                    let targetCurrent = 0;

                    if (chargeMode === 0) {
                        targetCurrent = 0; // Aus
                    } else if (chargeMode === 1) {
                        targetCurrent = 16; // Sofortladen
                    } else if (chargeMode === 2) {
                        // Min + PV Modus
                        const minCurrent = parseInt(this.config.minpv_minCurrent, 10) || 6;
                        const einschaltSoc = parseFloat(this.config.minpv_einschaltSoc) || 0;
                        
                        if (einschaltSoc === 0 || batSoc >= einschaltSoc) {
                            targetCurrent = minCurrent;
                        } else {
                            targetCurrent = 0;
                        }
                    } else if (chargeMode === 3) {
                        // Nur PV Modus (mit openWB Parametern)
                        const einschwelle = parseFloat(this.config.pv_einschaltschwelle) || 1600;
                        const minCurrent = parseInt(this.config.pv_minCurrent, 10) || 6;
                        const batPriority = this.config.bat_priority || "speicher";
                        const minSoc = parseFloat(this.config.bat_minSoc) || 100;

                        // Speicher-Beachtung Logik
                        let allowCharging = true;
                        if (batPriority === "speicher" && batSoc < minSoc) {
                            // Speicher hat Vorrang, solange minSoc nicht erreicht ist
                            allowCharging = false;
                        }

                        // Einspeisung prüfen (negative EVU-Power bedeutet Einspeisung)
                        // ruleMode: "evu" vs "erzeugungsfaktor"
                        const triggerPower = -einschwelle; 

                        if (allowCharging && effectiveEvuPower <= triggerPower) {
                            targetCurrent = minCurrent;
                        } else {
                            targetCurrent = 0;
                        }
                    } else if (chargeMode === 4) {
                        // Dynamischer Strompreis
                        const threshold = parseFloat(this.config.maxPriceThreshold) || 0.30;
                        if (currentPrice > 0 && currentPrice <= threshold) {
                            targetCurrent = 16;
                        } else {
                            targetCurrent = 0;
                        }
                    }
                    cpTargets[i] = targetCurrent;
                } else {
                    cpTargets[i] = 0;
                }
            }

            // Lastmanagement / Hausanschluss Schutzschleife
            const maxHouseCurrent = parseFloat(this.config.maxHouseCurrent) || 32;
            const maxHousePower = maxHouseCurrent * 230 * 3;
            let loadManagementActive = false;

            if (evuPower > (maxHousePower * 0.85)) {
                loadManagementActive = true;
                for (let i = 1; i <= 4; i++) {
                    if (cpTargets[i] > 6) cpTargets[i] = 6;
                    else if (evuPower > (maxHousePower * 0.95)) cpTargets[i] = 0;
                }
            }

            await this.setStateAsync('control.loadManagementActive', { val: loadManagementActive, ack: true });

            let totalPower = 0;
            for (let i = 1; i <= 4; i++) {
                const writeState = this.config[`cp${i}_writeState`];
                const powerState = this.config[`cp${i}_powerState`];
                const enabled = this.config[`cp${i}_enabled`];

                if (i <= numCP && enabled && writeState) {
                    const targetCurrent = cpTargets[i];
                    const shouldCharge = targetCurrent > 0;

                    await this.setStateAsync(writeState, { val: targetCurrent, ack: false });
                    await this.setStateAsync(`cp${i}.active`, { val: shouldCharge, ack: true });

                    if (powerState) {
                        const pState = await this.getStateAsync(powerState);
                        if (pState && typeof pState.val === 'number') {
                            totalPower += pState.val;
                        }
                    }
                } else {
                    await this.setStateAsync(`cp${i}.active`, { val: false, ack: true });
                }
            }

            await this.setStateAsync('control.totalChargingPower', { val: totalPower, ack: true });

        } catch (error) {
            this.log.error(`Fehler in der Regelschleife: ${error}`);
        }
    }

    onUnload(callback) {
        try {
            clearInterval(this.interval);
            callback();
        } catch (e) {
            callback();
        }
    }

    onStateChange(id, state) {
        if (state) {
            this.log.info(`State ${id} geändert zu: ${state.val}`);
        }
    }
}

if (require.main === module) {
    new VirtualWb();
} else {
    module.exports = (options) => new VirtualWb(options);
}
