import sdk, { ScryptedDeviceBase } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";

const { systemManager, mediaManager, endpointManager } = sdk;

export default class RemoteBackup extends ScryptedDeviceBase {
    storageSettings = new StorageSettings(this, {
        pluginEnabled: {
            title: 'Plugin enabled',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        serverId: {
            title: 'Server identifier',
            type: 'string',
            hide: true,
        },
    });

    constructor(nativeId: string) {
        super(nativeId);

        this.initFlow().then().catch(console.log);
    }

    async initFlow() {
        try {
        } catch (e) {
            this.console.log(`Error in initFLow`, e);
        }
    }
}