# reactor-espresense
ESPPresense Controller for Reactor - Multi-Hub Automation.

[ESPresence](https://espresense.com/) is required and needs to be configured under the same MQTT broker.

## Installation
ESPPresense Controller must be installed separately. Just download all the files from this repo.

Create, if it does not already exist, a directory called *ext* in your Reactor install directory (so it should be at the same level as config, storage, etc.).

```
cd /path/to/reactor
mkdir ext
```

If you are running Reactor in a docker container, the *ext* directory should be created in the data directory, where your config and storage directories live as indicated above.

Change directory into the new *ext* directory:

```
cd ext
mkdir ESPresenseController
```

Copy all the files in a new directory called *ESPresenseController*.
Your final path should be */path/to/reactor/ext/ESPresenseController*.
You're now ready to run your new controller, since no external packages are required.

From here, proceed to Basic Configuration below.

## Basic Configuration

In order to use ESPPresenseController, you have to add an entry for it to the controllers section of your *reactor.yaml* file.

```
controllers:
  # Your existing controllers will be below the above line.
  # Add the following after the last "- id" line in this
  # section.
  - id: espresense
    name: ESPresense
    implementation: ESPresenseController
    enabled: true
    config:
      # MQTTController id under MSR: default is mqtt
      #mqtt_controller: mqtt

      # interval for update: default 5 secs
      #interval: 5000

      # timeout: default 60 secs
      #timeout: 60000

      # error_interval: default 10 secs
      #error_interval: 10000

      # rssi to consider before the device is considered out of range: default 10 secs
      #rssiForHome: -100

      # timeout after a device is considered dead - default 5 days
      #purgeTimeout: 432000000 # 5 days

      devices:
        - 'iBeacon:agcd-defg'
        - 'irk:abcd'
```

Remember to add the ID of your devices under *devices* section. If devices are not added, they will not tracked. Each time a new device is added, a new entity will be automatically created. To get your device IDs, go to *http://stationIP/ui/#/fingerprints*.

Restart Reactor to make the changes take effect. After that, you should be able to refresh the UI, go the Entities list, clear any existing filters, and choose "ESPPresense" from the controllers filter selector. That should then show you at least two entities: the ESPPresense controller system entity, and its default group entity - and a new entity for each device you'd to track. If you don't see this, check the log for errors.

[More info on Apple devices.](https://community.home-assistant.io/t/espresense-device-id-how-to-get-them/403018/15?u=gwp1)

## Logic for presence detection

Everytime your beacon/device is recognized, a new message will be sent to the MQTT broker. This will be used to update internal data (distance, rssi, rssi at 1 mt, speed) and the room it is in. If you're using multiple base stations, the room will be detected by analyzing the latest message, with the *distance* attribute being used to determine the nearest base station.

Each *interval* msecs, the devices are analyzed to understand if they're still connected. If your beacon/device stops reporting, after *timeout* msecs, the device will be marked as *not_home*. Depending on your beacon/device, the next message will set the device in the correct room as soon as it's received. This is usually very fast for entering a room, and has some timeout when leaving. Program your reactions accordingly.

After 5 days, a device is considered dead and marked for deletion. Adjust *purgeTimeout* in settings to support your needs.

## Support

This is beta software, so expect quirks and bugs. Support is provided via https://smarthome.community/.