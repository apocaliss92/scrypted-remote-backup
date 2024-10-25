import sdk, { ScryptedDeviceBase, Setting, SettingValue } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import cron, { ScheduledTask } from 'node-cron';
import fs from "fs"
import path from 'path';
import { Samba } from "./samba";
import { BackupService, BackupServiceEnum, fileExtension, findFilesToRemove } from "./types";
import { Local } from "./local";

const BACKUP_FOLDER = path.join(process.env.SCRYPTED_PLUGIN_VOLUME, 'backups');
const backupServices: BackupServiceEnum[] = [BackupServiceEnum.Samba];

export default class RemoteBackup extends ScryptedDeviceBase {
    private cronTask: ScheduledTask;
    private localService: Local;

    storageSettings = new StorageSettings(this, {
        pluginEnabled: {
            title: 'Plugin enabled',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        backupService: {
            title: 'Backup service',
            type: 'string',
            choices: backupServices,
            defaultValue: backupServices[0]
        },
        maxBackupsLocal: {
            title: 'Max backups to keep locally',
            type: 'number',
            defaultValue: 7,
        },
        maxBackupsCloud: {
            title: 'Max backups to keep on cloud',
            type: 'number',
            defaultValue: 7,
        },
        filePrefix: {
            title: 'File prefix. Should not contain the character "_"',
            type: 'string',
            defaultValue: 'scrypted-backup'
        },
        cronSchedule: {
            title: 'Cron scheduler',
            type: 'string',
            defaultValue: '0 4 * * *'
        },
        backupNow: {
            title: 'Manual backup',
            type: 'button',
            onPut: async () => await this.executeBackup(new Date())
        },
        checkFiles: {
            title: 'Check files',
            description: 'Remove all the exceeding files on both local and cloud',
            type: 'button',
            onPut: async () => await this.checkMaxFiles()
        },
        // SAMBA
        sambaAddress: {
            title: 'Server address',
            group: 'Samba',
            type: 'string',
            hide: true,
            placeholder: '//server/share'
        },
        sambaTargetDirectory: {
            title: 'Target directory in the share',
            group: 'Samba',
            type: 'string',
            hide: true
        },
        sambaUsername: {
            title: 'Username',
            group: 'Samba',
            type: 'string',
            hide: true,
            placeholder: 'guest'
        },
        sambaPassword: {
            title: 'Password',
            group: 'Samba',
            type: 'password',
        },
        sambaDomain: {
            title: 'Domain',
            group: 'Samba',
            placeholder: 'WORKGROUP',
            type: 'string',
            hide: true,
        },
        sambaMaxProtocol: {
            title: 'Max protocol',
            group: 'Samba',
            placeholder: 'SMB3',
            type: 'string',
            hide: true,
        },
        sambaMaskCmd: {
            title: 'Mask commands',
            group: 'Samba',
            type: 'boolean',
            defaultValue: false,
            hide: true,
        },
        // SAMBA
    });

    constructor(nativeId: string) {
        super(nativeId);

        const keysToReinitialize: (keyof typeof this.storageSettings.settings)[] = [
            'cronSchedule',
            'pluginEnabled',
        ]

        keysToReinitialize.forEach(key => this.storageSettings.settings[key].onPut = async () => this.initScheduler());

        this.localService = new Local(BACKUP_FOLDER, this.console);
        this.storageSettings.settings.checkFiles.onPut = async () => await this.checkMaxFiles();
        this.initScheduler().then().catch(console.log);
    }

    async getSettings() {

        const backupService = this.storageSettings.getItem('backupService');

        if (backupService === BackupServiceEnum.Samba) {
            this.storageSettings.settings.sambaAddress.hide = false;
            this.storageSettings.settings.sambaTargetDirectory.hide = false;
            this.storageSettings.settings.sambaUsername.hide = false;
            this.storageSettings.settings.sambaPassword.hide = false;
            this.storageSettings.settings.sambaDomain.hide = false;
            this.storageSettings.settings.sambaMaskCmd.hide = false;
        }

        const settings: Setting[] = await this.storageSettings.getSettings();

        return settings;
    }

    putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    async initScheduler() {
        try {
            if (this.cronTask) {
                this.console.log('Stopping scheduler');
                this.cronTask.stop();
                this.cronTask = undefined;
            }

            if (!this.storageSettings.getItem('pluginEnabled')) {
                this.console.log('Plugin is disabled');

                return;
            }

            const cronTime = this.storageSettings.getItem('cronSchedule');
            if (!cronTime) {
                this.console.log(`Cron scheduler is not set`);

                return;
            }

            this.console.log(`Starting scheduler with ${cronTime}`);

            this.cronTask = cron.schedule(cronTime, async () => {
                try {
                    const now = new Date();
                    this.console.log(`Executing scheduled backup at ${now.toLocaleString()}`);
                    await this.executeBackup(now);
                    await this.checkMaxFiles();
                } catch (e) {
                    this.console.log('Error executing the scheduled backup: ', e);
                }
            });
        } catch (e) {
            this.console.log('Error in initScheduler', e);
        }
    }

    private async getBackupService() {
        try {
            if (this.storageSettings.values.backupService === BackupServiceEnum.Samba) {
                const address = this.storageSettings.getItem('sambaAddress');
                const username = this.storageSettings.getItem('sambaUsername');
                const password = this.storageSettings.getItem('sambaPassword');
                const domain = this.storageSettings.getItem('sambaDomain');
                const maxProtocol = this.storageSettings.getItem('sambaMaxProtocol');
                const maskCmd = this.storageSettings.getItem('sambaMaskCmd');
                const directory = this.storageSettings.getItem('sambaTargetDirectory');

                return new Samba({
                    address,
                    username,
                    password,
                    domain,
                    maxProtocol,
                    maskCmd,
                    directory
                }, this.console)
            }
        } catch (e) {
            this.console.log('Error during service init', e);
        }
    }

    async executeBackup(date: Date) {
        const filePrefix = this.storageSettings.getItem('filePrefix');
        const { fileName, filePath } = await this.localService.downloadBackup({ filePrefix, date })

        const service = this.storageSettings.values.backupService as BackupServiceEnum;

        this.console.log(`Starting upload to ${service}.`);
        (await this.getBackupService()).uploadBackup({ fileName, filePath });
        this.console.log(`Upload to ${service} completed.`);
    }

    async checkMaxFiles() {
        const service = this.storageSettings.getItem('backupService') as BackupServiceEnum;
        const maxBackupsCloud = this.storageSettings.getItem('maxBackupsCloud') as number;
        const maxBackupsLocal = this.storageSettings.getItem('maxBackupsLocal') as number;
        const filePrefix = this.storageSettings.getItem('filePrefix');

        const cloudClient = await this.getBackupService();
        this.console.log(`Starting ${service} max filess cleanup.`);
        const serviceFilesRemoved = await cloudClient.pruneOldBackups({ filePrefix, maxBackups: maxBackupsCloud });
        this.console.log(`${service} max files cleanup completed. Removed ${serviceFilesRemoved} backups.`);

        this.console.log(`Starting local max filess cleanup.`);
        const localFilesRemoved = await this.localService.pruneOldBackups({ filePrefix, maxBackups: maxBackupsLocal });
        this.console.log(`Local max files cleanup completed. Removed ${localFilesRemoved} backups.`);
    }
}