// mochad, X10 CM15a and CM19a Platform Plugin for HomeBridge
// This is a simple derivative of homebridge-heyu, https://github.com/keithws/homebridge-heyu/blob/master/index.js
// mochad is a TCP gateway daemon for X10 CM15A and CM19a devices, https://github.com/bjonica/mochad
// This communicates with a running mochad daemon over TCP to handle integration with HomeBridge.
// Evan Heller, Mar. 2017
//
// Remember to add this platform to your config.json. Example:
//"platforms": [{
//       "platform": "Mochad",
//       "name": "Mochad",
//       "x10conf": "/etc/x10.conf",     
//       "mochadPort": 1099,           //optional, default to 1099 
//   }]
//
// The x10.conf takes the format: ALIAS Name Homecode Platform, i.e.:
// ALIAS Front_Door A1 DS10A


"use strict";

var net = require('net'); //For getting/issuing commands to mochad
var Accessory, Characteristic, PowerConsumption, Service, uuid;
var exec = require('child_process').execFile;
var os = require("os");
var x10conf, mochadPort, cputemp;
var noMotionTimer;
var X10Commands = {
    on: "on",
    off: "off",
    bright: "bright",
    preset: "preset",
    dim: "dim",
    dimlevel: "dimlevel",
    rawlevel: "rawlevel",
    allon: "allon",
    alloff: "alloff",
    lightson: "lightson",
    lightsoff: "lightsoff",
    onstate: "onstate"
};

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    Accessory = homebridge.hap.Accessory;
    uuid = homebridge.hap.uuid;

    homebridge.registerPlatform("homebridge-mochad", "Mochad", MochadPlatform);
};

function MochadPlatform(log, config) {
    this.log = log;
    this.log("Mochad Platform Plugin Loaded ");
    this.faccessories = {}; // an array of accessories by housecode

    // platform options
    mochadPort = config.mochadPort || 1099;
    x10conf = config.x10conf || "/etc/x10.conf";
    cputemp = config.cputemp;

    this.config = config;
    this.devices = this.config.devices;
}

function readX10config() {
    var fs = require('fs');
    var x10confObject = {};

    var x10confData = fs.readFileSync(x10conf);
    var pattern = new RegExp('ALIAS.*', 'ig');

    // ALIAS Front_Porch A1 StdLM

    var match = [];
    while ((match = pattern.exec(x10confData)) != null) {
        var line = match[0].split(/[ \t]+/);

        x10confObject[line[1]] = {
            'name': line[1].replace(/_/g, ' '),
            'housecode': line[2],
            'module': line[3]
        };
    }

    return x10confObject;
}


MochadPlatform.prototype = {
    accessories: function(callback) {
        var foundAccessories = [];
        var self = this;
        var devices = new readX10config();

        //Create a TCP client and listen for mochad events
        this.tcpServer = net.Socket();
        this.tcpServer.connect(mochadPort, 'localhost', function() {
            self.log("Connection to port: %d", mochadPort);
        });

        this.tcpServer.on('data', (data) => {
            self.log('UNIX socket data: "' + data + '"');
            self.handleOutput(self, data);
        });

        this.tcpServer.on('listening', () => {
            self.log("Listening for events on port %d", mochadPort);
        });

        this.tcpServer.on('error', (e) => {
            self.log('TCP client error');
            throw(e); // re-raise
        })

        for (var i in devices) {
            var device = devices[i];
            this.log("Found in x10.conf: %s %s %s", device.name, device.housecode, device.module);
            var accessory = new MochadAccessory(self.log, device, this.tcpServer);
            foundAccessories.push(accessory);
            var housecode = device.housecode;
            self.faccessories[housecode] = accessory;
        }

        // Built-in accessories and macro's
        {
            var device;
            device.name = "All Devices";
            device.housecode = "A";
            device.module = "Macro-allon";
            var accessory = new MochadAccessory(self.log, device, null);
            foundAccessories.push(accessory);
        } {
            var device;
            device.name = "All Lights";
            device.housecode = "A";
            device.module = "Macro-lightson";
            var accessory = new MochadAccessory(self.log, device, null);
            foundAccessories.push(accessory);
        }

        if (cputemp != undefined) {
            var device;
            device.name = os.hostname();
            device.module = "Temperature";
            var accessory = new HeyuAccessory(self.log, device, null);
            foundAccessories.push(accessory);
        }


        callback(foundAccessories);
    },
};


function MochadAccessory(log, device, enddevice) {
    // This is executed once per accessory during initialization

    var self = this;

    self.device = device;
    self.log = log;
    self.name = device.name;
    self.housecode = device.housecode;
    self.module = device.module;
    self.tcpServer = enddevice;

    self.on_command = X10Commands.on;
    self.off_command = X10Commands.off;
    self.status_command = X10Commands.onstate;
    self.brightness_command = X10Commands.dimlevel;
    self.statusHandling = "yes";
    self.dimmable = "yes";

}

MochadPlatform.prototype.handleOutput = function(self, data) {

    // 06/16 20:32:48  rcvi addr unit       5 : hu A5  (Family_room_Pot_lights)
    // 06/16 20:32:48  rcvi func          Off : hc A

    var message = data.toString().split(/[ \t]+/);
    //    this.log("Message %s %s %s %s %s %s", message[2], message[3], message[4], message[5], message[6], message[7], message[8]);
    var operation = message[2];
    var proc = message[4];
    if (proc == "Addr:")
        var messageHousecode = 'A1';
    else if (proc == "Func:")
        var messageCommand = message[4];

    if (proc == "Addr:" && operation == "Rx") {
        this.log("Event occured at housecode %s", messageHousecode);
        var accessory = self.faccessories[messageHousecode];
        accessory.status_command=message[7];
        if (accessory != undefined) {
            self.MochadEvent(self, accessory);
        } else {
            this.log.error("Event occured at unknown device %s ignoring", messageHousecode);
        }
    }

}


MochadPlatform.prototype.MochadEvent = function(self, accessory) {

    var other = accessory;
    switch (other.module) {
        case "AM":
        case "AMS":
        case "AM12":
        case "StdAM":
        case "WS":
        case "WS-1":
        case "WS467":
        case "WS467-1":
        case "XPS3":
        case "StdWS":
            other.service.getCharacteristic(Characteristic.On)
                .getValue();
            break;
        case "LM":
        case "LM12":
        case "LM465":
        case "StdLM":
        case "SL2LM":
            other.service.getCharacteristic(Characteristic.Brightness)
                .getValue();
            other.service.getCharacteristic(Characteristic.On)
                .getValue();
            break;
        case "MS10":
        case "MS12A":
        case "MS13A":
        case "MS14A":
        case "MS16A":
            other.service.getCharacteristic(Characteristic.MotionDetected)
                .getValue();
            break;

        //Added this for an X10 contact sensor
        case "DS10A":
            other.service.getCharacteristic(Characteristic.ContactSensorState)
                .getValue();
            break;

        //Added this for an X10 RF-controlled outlet
        //This device is clunky as all hell, but...
        case "TM751":
            other.service.getCharacteristic(Characteristic.On)
                .getValue();
            break;

        default:
            this.log.error("No events defined for Module Type %s", this.module);
    }

}


MochadAccessory.prototype = {

    getServices: function() {
        var services = [];
        // set up the accessory information - not sure how mandatory any of this is.
        var service = new Service.AccessoryInformation();
        service.setCharacteristic(Characteristic.Name, this.name).setCharacteristic(Characteristic.Manufacturer, "Mochad");

        service
            .setCharacteristic(Characteristic.Model, this.module + " " + this.housecode)
            .setCharacteristic(Characteristic.SerialNumber, this.housecode)
            .setCharacteristic(Characteristic.FirmwareRevision, this.device.firmwareVersion)
            .setCharacteristic(Characteristic.HardwareRevision, this.module);

        services.push(service);

        switch (this.module) {
            case "Macro-allon": // The heyu allon macro
                this.log("Macro-allon: Adding %s %s as a %s", this.name, this.housecode, this.module);
                this.on_command = X10Commands.allon;
                this.off_command = X10Commands.alloff;
                this.dimmable = "no";
                this.statusHandling = "no";
                this.service = new Service.Switch(this.name);
                this.service
                    .getCharacteristic(Characteristic.On)
                    .on('get', function(callback) {
                        var that = this;
                        callback(null, that.state)
                    })
                    .on('set', this.setPowerState.bind(this));

                services.push(this.service);
                break;

            case "Macro-lightson": // The heyu allon macro
                this.log("Macro-allon: Adding %s %s as a %s", this.name, this.housecode, this.module);
                this.on_command = X10Commands.lightson;
                this.off_command = X10Commands.lightsoff;
                this.dimmable = "no";
                this.statusHandling = "no";
                this.service = new Service.Switch(this.name);
                this.service
                    .getCharacteristic(Characteristic.On)
                    .on('get', function(callback) {
                        var that = this;
                        callback(null, that.state)
                    })
                    .on('set', this.setPowerState.bind(this));

                services.push(this.service);
                break;

            case "LM":
            case "LM12":
            case "LM465":
            case "StdLM":
                this.log("StdLM: Adding %s %s as a %s", this.name, this.housecode, this.module);
                this.service = new Service.Lightbulb(this.name);
                this.service
                    .getCharacteristic(Characteristic.On)
                    .on('get', this.getPowerState.bind(this))
                    .on('set', this.setPowerState.bind(this));
                // Brightness Polling
                if (this.dimmable == "yes") {
                    this.service
                        .addCharacteristic(new Characteristic.Brightness())
                        .setProps({
                            minStep: 4.54
                        })
                        .on('get', this.getBrightness.bind(this))
                        .on('set', this.setBrightness.bind(this));
                }

                services.push(this.service);
                break;

            case "SL2LM":
                this.log("StdLM: Adding %s %s as a %s", this.name, this.housecode, this.module);
                this.service = new Service.Lightbulb(this.name);
                this.service
                    .getCharacteristic(Characteristic.On)
                    .on('get', this.getPowerState.bind(this))
                    .on('set', this.setPowerState.bind(this));
                // Brightness Polling
                if (this.dimmable == "yes") {
                    this.service
                        .addCharacteristic(new Characteristic.Brightness())
                        .setProps({
                            minValue: 3,
                            minStep: 3.125
                        })
                        .on('get', this.getSLBrightness.bind(this))
                        .on('set', this.setSLBrightness.bind(this));
                }

                services.push(this.service);
                break;
            case "AM":
            case "AMS":
            case "AM12":
            case "StdAM": case "TM751":
                this.log("StdAM: Adding %s %s as a %s", this.name, this.housecode, this.module);
                this.dimmable = "no"; // All Appliance modules are not dimmable
                this.service = new Service.Outlet(this.name);
                this.service
                    .getCharacteristic(Characteristic.On)
                    .on('get', this.getPowerState.bind(this))
                    .on('set', this.setPowerState.bind(this));
                services.push(this.service);
                break;

            case "WS":
            case "WS-1":
            case "WS467":
            case "WS467-1":
            case "XPS3":
            case "StdWS":
                this.log("StdWS: Adding %s %s as a %s", this.name, this.housecode, this.module);
                this.dimmable = "no"; // Technically some X10 switches are dimmable, but we're treating them as on/off
                this.service = new Service.Switch(this.name);
                this.service
                    .getCharacteristic(Characteristic.On)
                    .on('get', this.getPowerState.bind(this))
                    .on('set', this.setPowerState.bind(this));
                services.push(this.service);
                break;

            case "MS10":
            case "MS12A":
            case "MS13A":
            case "MS14A":
            case "MS16A":
                this.log("Motion Sensor: Adding %s %s as a %s", this.name, this.housecode, this.module);
                this.service = new Service.MotionSensor(this.name);
                this.service
                    .getCharacteristic(Characteristic.MotionDetected)
                    .on('get', this.getPowerState.bind(this));
                services.push(this.service);
                break;

                //Added contact sensor (the newer DS12A is identified as DS10A) 
            case "DS10A":
                this.log("Contact sensor: Adding %s %s as a %s", this.name, this.housecode, this.module);
                this.service = new Service.ContactSensor(this.name);
                this.service
                    .getCharacteristic(Characteristic.ContactSensorState)
                    .on('get', this.getPowerState.bind(this));

                services.push(this.service);
                break;

            case "Temperature":
                this.service = new Service.TemperatureSensor(this.name);
                this.service
                    .getCharacteristic(Characteristic.CurrentTemperature)
                    .on('get', this.getTemperature.bind(this));
                services.push(this.service);
                break;
            default:
                this.log.error("Unknown Module Type %s", this.module);
        }
        return services;
    },

    //start of Heyu Functions

    setPowerState: function(powerOn, callback) {
        var housecode;
        var command;

        if (!this.on_command || !this.off_command) {
            this.log.warn("Ignoring request; No power command defined.");
            callback(new Error("No power command defined."));
            return;
        }

        if (powerOn) {
            housecode = this.housecode;
            command = this.on_command;
        } else {
            housecode = this.housecode;
            command = this.off_command;
        }

        //Sending messages to mochad
        this.log("rf " + housecode + " " + command);	
        this.tcpServer.write("rf " + housecode + " " + command + "\n");
        this.powerOn = powerOn;
        this.log("Set power state of %s to %s", housecode, command);

        if (this.dimmable == "yes") {
            var that = this;
            that.service.getCharacteristic(Characteristic.Brightness)
                .getValue();
        }
        callback();


    },


    getPowerState: function(callback) {
        if (!this.status_command) {
            this.log.warn("Ignoring request; No status command defined.");
            callback(new Error("No status command defined."));
            return;
        }

        if (this.statusHandling == "no") {
            this.log.warn("Ignoring request; No status handling not available.");
            callback(new Error("No status handling defined."));
            return;
        }

        var housecode = this.housecode;
        var command = this.status_command;

        var status = command.indexOf("alert") > -1;
        this.log("Got state of %d for housecode %s", status, housecode);
        callback(null, status);
        this.powerOn = status;


    },

    getBrightness: function(callback) {
        if (!this.brightness_command) {
            this.log.warn("Ignoring request; No brightness command defined.");
            callback(new Error("No brightness command defined."));
            return;
        }

        if (this.dimmable == "no") {
            this.log.warn("Ignoring request; housecode not dimmable.");
            callback(new Error("Device not dimmable."));
            return;
        }


        var housecode = this.housecode;
        var command = this.brightness_command;
        this.tcpServer.write(command);
        callback();



    },

    getSLBrightness: function(callback) {
        if (!X10Commands.rawlevel) {
            this.log.warn("Ignoring request; No rawlevel command defined.");
            callback(new Error("No rawlevel command defined."));
            return;
        }

        if (this.dimmable == "no") {
            this.log.warn("Ignoring request; housecode not dimmable.");
            callback(new Error("Device not dimmable."));
            return;
        }

        this.tcpServer.write(command);
        callback();



    },


    setSLBrightness: function(level, callback) {
        var housecode = this.housecode;

        if (isNaN(this.brightness) || !this.powerOn) {
            var current = 0;
        } else {
            var current = this.brightness;
        }

        this.tcpServer.write(command);
        callback();


    },

    setBrightness: function(level, callback) {

        var housecode = this.housecode;

        if (isNaN(this.brightness) || !this.powerOn) {
            var current = 100;
        } else {
            var current = this.brightness;
        }

        if (level > current) {
            var command = X10Commands.bright;
            var delta = parseInt((level - current) / 4.54);
        } else {
            var command = X10Commands.dim;
            var delta = parseInt((current - level) / 4.54);
        }

        // Keyboard debouncing

        if (delta > 1) {

            this.tcpServer.write(command);
            callback();


        }
    },

    getTemperature: function(callback) {
        exec(cputemp, function(error, responseBody, stderr) {
            if (error !== null) {
                this.log('cputemp function failed: ' + error);
                callback(error);
            } else {
                var binaryState = parseInt(responseBody);
                this.log("Got Temperature of %s", binaryState);
                this.brightness = binaryState;
                callback(null, binaryState);
            }
        }.bind(this));
    },

    identify: function(callback) {
        this.log("Identify requested!");
        callback(); // success
    }
};

function pct2preset(percent) {

    if (percent < 5) {
        return 1;
    } else if (percent <= 18) {
        return 2;
    } else if (percent <= 21) {
        return 3;
    } else if (percent <= 23) {
        return 4;
    } else if (percent <= 27) {
        return 5;
    } else if (percent <= 28) {
        return 6;
    } else if (percent <= 31) {
        return 7;
    } else if (percent <= 34) {
        return 8;
    } else if (percent <= 36) {
        return 9;
    } else if (percent <= 39) {
        return 10;
    } else if (percent <= 42) {
        return 11;
    } else if (percent <= 45) {
        return 12;
    } else if (percent <= 48) {
        return 13;
    } else if (percent <= 51) {
        return 14;
    } else if (percent <= 54) {
        return 15;
    } else if (percent <= 57) {
        return 16;
    } else if (percent <= 60) {
        return 17;
    } else if (percent <= 63) {
        return 18;
    } else if (percent <= 67) {
        return 19;
    } else if (percent <= 70) {
        return 20;
    } else if (percent <= 73) {
        return 21;
    } else if (percent <= 76) {
        return 22;
    } else if (percent <= 79) {
        return 23;
    } else if (percent <= 82) {
        return 24;
    } else if (percent <= 85) {
        return 25;
    } else if (percent <= 87) {
        return 26;
    } else if (percent <= 90) {
        return 27;
    } else if (percent <= 92) {
        return 28;
    } else if (percent <= 95) {
        return 29;
    } else if (percent <= 97) {
        return 30;
    } else if (percent <= 99) {
        return 31;
    }
    return 32;
}
