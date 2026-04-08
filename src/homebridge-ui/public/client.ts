// Homebridge plugin for Home Connect home appliances
// Copyright © 2023-2026 Alexander Thoukydides

import { LogLevel, Logger } from 'homebridge';

import { ClientLogger, ServerLogger } from './logger.js';
import { Config } from './config.js';
import { Cards } from './cards.js';
import { ClientClientID } from './client-clientid.js';
import { FormId, Forms } from './forms.js';
import { ClientIPC } from './client-ipc.js';
import { APIStatus } from './api-status.js';
import { HomeAppliance } from '../../api-types.js';
import type { IdentifyApplianceStatus } from '../schema-data.js';
import { getElementById } from './utils-dom.js';

// Standalone identify panel shown for the currently selected appliance
class IdentifyPanel {

    readonly panel   = getElementById('hc-identify-panel');
    readonly name    = getElementById('hc-identify-name');
    readonly button  = getElementById('hc-identify-button');
    readonly loading = getElementById('hc-identify-loading');
    readonly message = getElementById('hc-identify-message');
    readonly output  = getElementById('hc-identify-output');

    appliances = new Map<string, HomeAppliance>();
    selectedHaId?: string;
    identifyRequestId?: string;

    constructor(readonly log: Logger, readonly ipc: ClientIPC) {
        this.button.onclick = async (event): Promise<void> => {
            event.preventDefault();
            await this.identifySelectedAppliance();
        };
    }

    // Update the list of known appliances
    setAppliances(appliances: HomeAppliance[]): void {
        this.appliances = new Map(appliances.map(appliance => [appliance.haId, appliance]));
        if (this.selectedHaId && !this.appliances.has(this.selectedHaId)) this.selectedHaId = undefined;
        this.render();
    }

    // Update which appliance is currently selected in the UI
    setSelected(id?: string): void {
        this.selectedHaId = this.appliances.has(id ?? '') ? id : undefined;
        this.render();
    }

    // Run identify for the selected appliance
    async identifySelectedAppliance(): Promise<void> {
        const appliance = this.selectedHaId ? this.appliances.get(this.selectedHaId) : undefined;
        if (!appliance || this.button.classList.contains('disabled')) return;

        this.setLoading(true);
        this.setMessage('Submitting identify request...', 'info');
        this.output.hidden = true;
        this.output.textContent = '';
        try {
            const requested = await this.ipc.request('/identify/appliance', appliance.haId);
            this.identifyRequestId = requested.requestId;
            this.renderStatus(requested);

            while (this.identifyRequestId === requested.requestId) {
                const status = await this.ipc.request('/identify/status', requested.requestId);
                const done = this.renderStatus(status);
                if (done) break;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            this.setMessage(`Unable to run identify: ${text}`, 'error');
        } finally {
            this.setLoading(false);
        }
    }

    // Refresh the panel for the currently selected appliance
    render(): void {
        const appliance = this.selectedHaId ? this.appliances.get(this.selectedHaId) : undefined;
        this.panel.hidden = !appliance;
        if (!appliance) return;
        this.name.textContent = `${appliance.name} (${appliance.haId})`;
    }

    // Display the progress/result of an identify request
    renderStatus(status: IdentifyApplianceStatus): boolean {
        const text = status.output?.trim();
        this.output.textContent = text ?? '';
        this.output.hidden = !text;
        switch (status.state) {
        case 'pending':
            this.setMessage('Identify request queued. Waiting for the running plugin instance to pick it up.', 'info');
            return false;
        case 'running':
            this.setMessage('Identify is running. Full output is also being written to the Homebridge log.', 'info');
            return false;
        case 'success':
            this.setMessage('Identify completed. Full output is shown below and in the Homebridge log.', 'success');
            return true;
        case 'error':
            this.setMessage(`Identify failed${status.error ? `: ${status.error}` : ''}`, 'error');
            return true;
        }
    }

    // Display a status message
    setMessage(text: string, kind: 'info' | 'success' | 'error'): void {
        this.message.textContent = text;
        this.message.classList.remove('hc-identify-info', 'hc-identify-success', 'hc-identify-error');
        this.message.classList.add(`hc-identify-${kind}`);
    }

    // Enable or disable the identify action
    setLoading(active: boolean): void {
        this.button.classList.toggle('disabled', active);
        this.button.setAttribute('aria-disabled', String(active));
        this.loading.hidden = !active;
    }
}

// A Homebridge HomeConnect custom UI client
class Client {

    // Custom loggers
    readonly log:   Logger;
    serverLog?:     Logger;

    // Local resources
    readonly ipc: ClientIPC;

    // Create a new custom UI client
    constructor() {
        // Create a local logger and IPC client
        this.log = new ClientLogger();
        this.log.debug('homebridge.plugin', window.homebridge.plugin);
        this.ipc = new ClientIPC(this.log);

        // Wait for the server before continuing initialisation
        this.ipc.onEvent('ready', () => { this.serverReady(); });
    }

    // The server is ready so finish initialising the client
    serverReady(): void {
        // Start receiving (important) log messages from the server
        this.serverLog = new ServerLogger(this.ipc, LogLevel.WARN);

        // Create all of the required resources
        const config = new Config(this.log, this.ipc);
        const forms  = new Forms(this.log, this.ipc, config);
        const cards  = new Cards(this.log);
        const client = new ClientClientID(this.log, this.ipc);
        const identify = new IdentifyPanel(this.log, this.ipc);
        new APIStatus(this.log);

        // Create cards for the global settings and each available appliance
        cards.setNonAppliances([{ id: FormId.Global, icon: 'global', name: 'General Settings' }]);
        client.onAppliances = (appliances):  void => {
            cards.setAppliances(appliances ?? []);
            identify.setAppliances(appliances ?? []);
        };
        cards.onSelect      = (id?: string): void => {
            forms.showForm(id);
            identify.setSelected(id);
        };

        // Attempt to authorise a client when the configuration changes
        config.onGlobal = (config): void => { client.setClient(config); };
        client.onFail   = ():       void => { forms.showForm(FormId.Global); };
    }
}

// Create a custom UI client instance
new Client();
