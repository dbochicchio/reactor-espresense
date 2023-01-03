/** A Reactor controller for ESPresense.
 *  Copyright (c) 2023 Daniele Bochicchio, All Rights Reserved.
 *  ESPresenseController is offered under MIT License - https://mit-license.org/
 *  More info: https://github.com/dbochicchio/reactor-espresense
 */

const version = 230103;
const className = "espresense";
const ns = "x_espresense"
const ignoredValue = "@@IGNORED@@"

const Controller = require("server/lib/Controller");

const Logger = require("server/lib/Logger");
Logger.getLogger('ESPresenseController', 'Controller').always("Module ESPresenseController v%1", version);

const Configuration = require("server/lib/Configuration");
const logsdir = Configuration.getConfig("reactor.logsdir");  /* logs directory path if you need it */

// modules
const util = require("server/lib/util");

const delay = ms => new Promise(res => setTimeout(res, ms));

var impl = false;  /* Implementation data, one copy for all instances, will be loaded by start() later */

module.exports = class ESPresenseController extends Controller {
    constructor(struct, id, config) {
        super(struct, id, config);  /* required *this.*/

        this.failures = 0;

        this.stopping = false;      /* Flag indicates we're stopping */
        this.connected = false;
    }

    /** Start the controller. */
    async start() {
        /** Load implementation data if not yet loaded. Remove this if you don't
         *  use implementation data files.
         */
        if (false === impl) {
            impl = await this.loadBaseImplementationData(className, __dirname);
        }

        this.log.notice("%1 starting", this);

        this.stopping = false;
        this.firstRun = true;

        this.mqttController == undefined;

        this.devices = this.config.devices || [];

        this.log.notice("%1 [run] devices: - %2", this, this.devices);
        this.run();

        // mark other entities as dead
        var entities = this.getEntities();
        for (let [eid, e] of Object.entries(entities)) {
            let markDead = true;
            var lastupdate = e.getAttribute(`${ns}.lastupdate`);
            if (lastupdate !== undefined)
                markDead = Date.now() - lastupdate > (this.config.purgeTimeout || (86400000 * 5)); // 5 day

            // no need to mark controllers/groups as dead
            if (eid == 'controller_all' || eid == 'system')
                markDead = false;

            e.markDead(markDead);
            this.log.debug(5, "%1 [MarkDead] %2 - Dead: %3", this, eid, markDead);

            if (markDead) {
                this.log.notice("%1 device %2 no longer available, marking %3 for removal", this, id, e);
                this.sendWarning("Controller {0} device {1:q} ({2}) no longer exists.", this.getID(), eid, e.getName());
            }
        }
        this.purgeDeadEntities();

        return this;
    }

    /* Stop the controller. */
    async stop() {
        this.log.notice("%1 stopping", this);
        this.stopping = true;

        // unsubscribe from qtt
        if (this.mqttController !== undefined)
            this.mqttController.extUnsubscribeTopic(this, null);

        /* Required ending */
        return await super.stop();
    }

    /* run() is called when Controller's single-simple timer expires. */
    run() {
        this.log.debug(5, "%1 running", this);

        this.registerMqttController();

        this.startClient();

        this.firstRun = false;
    }

    /* startClient() load status and creates the entities */
    startClient() {
        if (this.stopping) return;

        // analyze status and set devices as offline
        this.devices.forEach(device => {
            let e = this.findEntity(this.normalizeId(device));
            if (e != undefined) {
                var lastupdate = e.getAttribute(`${ns}.lastupdate`);
                var expired = Date.now() - lastupdate > (this.config.timeout || 60_000);
                this.log.debug(5, "%1 [check] %2 - lastupdate: %3 - expired: %4", this, device, lastupdate, expired);
                if (expired) {
                    this.updateEntityAttributes(e, {
                        "presence_sensor.state": false,
                        "string_sensor.value": 'not_home',
                        "_ns_.lastupdate": Date.now()
                    });
                }
            }
        });

        this.startDelay(this.config.interval || 5_000);
    }

    /* init MQTT message handler, if needed */
    registerMqttController() {
        this.log.debug(5, "%1 [registerMqttController] started - %2", this, this.mqttController);
        if (this.mqttController === undefined) {
            try {
                var mqttControllerId = this.config.mqtt_controller || 'mqtt';
                this.mqttController = this.getStructure().getControllerByID(mqttControllerId);

                if (this.mqttController !== undefined) {
                    this.log.debug(5, "%1 [registerMqttController] MQTT topic subscription in progress for %2", this, mqttControllerId);

                    // subscribe to updates for each registered device
                    this.devices.forEach(device => {
                        this.mqttController.extSubscribeTopic(this, `espresense/devices/${device}/#`, this.onMqttMessage.bind(this));
                    });

                    this.online();

                    return true;
                }
                else {
                    this.log.err("%1 [registerMqttController] MQTT is configured, but can't find '%2' under MSR. Check your config.", this, mqttControllerId);
                    return false;
                }
            } catch (err) {
                this.log.err("%1 [registerMqttController] error: %2", this, err);
            }
        }

        return this.mqttController !== undefined; // if MQTT setup is not valid
    }

    /* handle incoming messages from MQTT broker */
    onMqttMessage(topic, value) {
        this.log.debug(5, "%1 [onMqttMessage] %2: %3", this, topic, value);

        var rssiForHome = parseFloat(this.config.rssiForHome ?? -120);

        if (topic.startsWith('espresense/devices/') && (value || '') !== '') {
            var device = JSON.parse(value);
            var id = device.id;

            if (this.devices.includes(id)) {
                let e = this.findEntity(this.normalizeId(id));
                let room = topic.split('/').slice(-1)[0].toLowerCase();

                // device not found: let's create it
                if (e === undefined) {
                    this.log.notice("%1 [onMqttMessage] %2 MAPPED as handled device", this, id);
                    e = this.mapDevice(id, `ESPresense ${id}`,
                        ["presence_sensor", "string_sensor", ns], "string_sensor.value",
                        {
                            "_ns_.idtype": device.idType,
                            "_ns_.lastupdate": Date.now()
                        });
                }
                else
                    this.log.debug(5, "%1 [onMqttMessage] %2 MAPPED as handled device", this, id);

                // accumulate rawdata by room
                let currentRawData = {
                    rssi: parseFloat(device.rssi),
                    raw: parseFloat(device.raw),
                    distance: parseFloat(device.distance),
                    speed: parseFloat(device.speed),
                    room: room,
                    lastupdate: Date.now()
                };
                let rawdata = e.getAttribute(`${ns}.rawdata`) || [];

                // take just the last measurement per room
                let data = rawdata.filter(x => x.room != room);
                data.unshift(currentRawData);

                // get nearest and most current data from rooms
                let currentStatus = data
                    // first get current data
                    .filter(x => Date.now() - x.lastupdate < (this.config.timeout || 60_000))
                    // then by best proximity
                    .reduce((prev, curr) =>
                        (curr.distance > prev.distance && curr.lastupdate > prev.lastupdate) ? curr : prev
                    ) ?? currentRawData;

                // update device using the most current status
                this.updateEntityAttributes(e, {
                    "_ns_.rawdata": data,
                    "presence_sensor.state": currentStatus.rssi >= rssiForHome,
                    "string_sensor.value": currentStatus.rssi >= rssiForHome ? currentStatus.room : 'not_home',
                    "_ns_.rssi": currentStatus.rssi,
                    "_ns_.raw": currentStatus.raw,
                    "_ns_.distance": currentStatus.distance,
                    "_ns_.speed": currentStatus.speed,
                    "_ns_.interval": currentStatus.interval,
                    "_ns_.lastupdate": currentStatus.lastupdate
                });
            }
            else
                if (this.firstRun)
                    this.log.notice("%1 [onMqttMessage] %2 not mapped as handled device. Please add it to config if you want to manage it.", this, id);
        }
    }

    onError(err) {
        console.log(err);
        this.log.err("%1 Error: %2", this, err);
        this.startDelay(Math.min(120_000, (this.config.error_interval || 5_000) * Math.max(1, ++this.failures - 12)));

        if (this.failures >= 3) {
            this.offline();
        }
    }

    /* performOnEntity() is used to implement actions on entities */
    async performOnEntity(entity, actionName, params) {
        this.log.notice("%1 [performOnEntity] %3 - %2 - %4", this, actionName, entity, params);

        switch (actionName) {
            case 'sys_system.restart':
                this.mqttController = undefined;
                this.offline();
                this.startClient();
                return;
        }

        return super.performOnEntity(entity, actionName, params);
    }

    /* Maps a device into a MSR entity */
    mapDevice(id, name, capabilities, defaultAttribute, attributes) {
        this.log.debug(5, "%1 mapDevice(%2, %3, %4, %5, %6)", this, id, name, capabilities, defaultAttribute, attributes);

        let e = this.findEntity(this.normalizeId(id));

        try {
            if (!e) {
                this.log.notice("%1 Creating new entity for %2", this, name);
                e = this.getEntity(className, this.normalizeId(id));
                e.setName(name);
                e.setType(className);
            }

            e.deferNotifies(true);
            e.markDead(false);

            // capabilities
            if (capabilities) {
                this.log.debug(5, "%1 [%2] adding capabilities: %3", this, id, capabilities);
                capabilities.forEach(c => {
                    if (!e.hasCapability(c)) {
                        this.log.debug(5, "%1 [%2] adding capability %3", this, id, c);
                        e.extendCapability(c);
                    }
                });
            }

            this.updateEntityAttributes(e, attributes);

            if (defaultAttribute)
                e.setPrimaryAttribute(defaultAttribute);
        } catch (err) {
            this.log.err("%1 [mapDevice] error: %2", this, err);
        } finally {
            e.deferNotifies(false);
        }

        return e;
    }

    updateEntityAttributes(e, attributes) {
        if (e && attributes) {
            for (const attr in attributes) {
                var newValue = attributes[attr];

                // skip ignored values
                if (ignoredValue != newValue) {
                    // check if value has changed
                    var attrName = attr.replace(/_ns_/g, ns);
                    var value = e.getAttribute(attrName);

                    // check for and skip unchanged values
                    var changed = value != newValue && JSON.stringify(value) != JSON.stringify(newValue);
                    if (changed) {
                        var id = e.getCanonicalID();
                        this.log.debug(7, "%1 [%2] %3: %4 => %5", this, id, attrName, newValue, value);
                        e.setAttribute(attrName, newValue);
                    }
                }
            };
        }
    }

    normalizeId(id) {
        return id.replace(/:/gi, '_').replace(/-/gi, '_').toLowerCase();
    }
};