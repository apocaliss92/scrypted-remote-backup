import sdk, { ScryptedDeviceBase, Setting, SettingValue } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import cron, { ScheduledTask } from 'node-cron';
import { Samba } from "./samba";
import { BackupServiceEnum, fileExtension, findFilesToRemove } from "./types";
import { Local } from "./local";
import { Sftp } from "./sftp";
import fs from "fs"

enum RestoreSource {
    Local = 'Local',
    Cloud = 'Cloud',
}

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
            choices: [BackupServiceEnum.Samba, BackupServiceEnum.SFTP],
            defaultValue: BackupServiceEnum.Samba,
            immediate: true,
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
        // RESTORE
        restoreSource: {
            title: 'Restore source',
            group: 'Restore',
            type: 'string',
            choices: [RestoreSource.Local],
            // choices: [RestoreSource.Local, RestoreSource.Cloud],
            defaultValue: RestoreSource.Local,
            immediate: true,
            onPut: async () => await this.fetchFiles(),
        },
        backupToRestore: {
            title: 'Backup file',
            group: 'Restore',
            type: 'string',
            immediate: true,
            choices: [],
        },
        refreshFiles: {
            title: 'Refresh files',
            group: 'Restore',
            type: 'button',
            onPut: async () => await this.fetchFiles(),
        },
        restore: {
            title: 'Restore backup',
            group: 'Restore',
            type: 'button',
            onPut: async () => await this.restoreBackup(),
        },
        // RESTORE
        //
        // SAMBA
        sambaAddress: {
            title: 'Server address',
            group: BackupServiceEnum.Samba,
            type: 'string',
            hide: true,
            placeholder: '//server/share'
        },
        sambaTargetDirectory: {
            title: 'Target directory in the share',
            group: BackupServiceEnum.Samba,
            type: 'string',
            hide: true
        },
        sambaUsername: {
            title: 'Username',
            group: BackupServiceEnum.Samba,
            type: 'string',
            hide: true,
            placeholder: 'guest'
        },
        sambaPassword: {
            title: 'Password',
            group: BackupServiceEnum.Samba,
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
            group: BackupServiceEnum.Samba,
            placeholder: 'SMB3',
            type: 'string',
            hide: true,
        },
        sambaMaskCmd: {
            title: 'Mask commands',
            group: BackupServiceEnum.Samba,
            type: 'boolean',
            defaultValue: false,
            hide: true,
        },
        // SAMBA
        //
        // SFTP
        sftpHost: {
            title: 'Server host',
            group: BackupServiceEnum.SFTP,
            type: 'string',
            hide: true,
            placeholder: '192.168.1.1'
        },
        sftpPort: {
            title: 'Server port',
            group: BackupServiceEnum.SFTP,
            type: 'number',
            hide: true,
            placeholder: '22',
            defaultValue: 22
        },
        sftpTargetDirectory: {
            title: 'Target directory',
            group: BackupServiceEnum.SFTP,
            type: 'string',
            hide: true
        },
        sftpUsername: {
            title: 'Username',
            group: BackupServiceEnum.SFTP,
            type: 'string',
            hide: true,
            placeholder: 'guest'
        },
        sftpPassword: {
            title: 'Password',
            group: BackupServiceEnum.SFTP,
            type: 'password',
        },
        // SFTP
    });

    constructor(nativeId: string) {
        super(nativeId);

        const keysToReinitialize: (keyof typeof this.storageSettings.settings)[] = [
            'cronSchedule',
            'pluginEnabled',
        ]

        keysToReinitialize.forEach(key => this.storageSettings.settings[key].onPut = async () => this.initScheduler());


        this.localService = new Local(this.console);
        this.storageSettings.settings.checkFiles.onPut = async () => await this.checkMaxFiles();
        this.initScheduler().then().catch(console.log);
        this.fetchFiles().then().catch(console.log);
    }

    async getSettings() {
        const backupService = this.storageSettings.getItem('backupService');
        const allServices = this.storageSettings.settings.backupService.choices;

        Object.entries(this.storageSettings.settings).forEach(([_, setting]) => {
            if (setting.group === backupService) {
                setting.hide = false;
            } else if (allServices.includes(setting.group)) {
                setting.hide = true;
            }
        })

        const settings: Setting[] = await this.storageSettings.getSettings();

        return settings;
    }

    putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    async fetchFiles() {
        const filePrefix = this.storageSettings.getItem('filePrefix');
        const restoreSource = this.storageSettings.getItem('restoreSource') as RestoreSource;

        this.console.log(`Fetching available backups`);
        try {
            let backups = [];
            if (restoreSource === RestoreSource.Local) {
                const cloudService = await this.getBackupService();
                backups = await cloudService.getBackupsList({ filePrefix });
            } else {
                backups = await this.localService.getBackupsList({ filePrefix });
            }
            this.console.log(`${backups.length} backups found.`);
            this.storageSettings.settings.backupToRestore.choices = backups;
        } catch (e) {
            this.console.log('Error fetching available backups', e);
        };
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
                }, this.console);
            } else if (this.storageSettings.values.backupService === BackupServiceEnum.SFTP) {
                const host = this.storageSettings.getItem('sftpHost');
                const port = this.storageSettings.getItem('sftpPort');
                const username = this.storageSettings.getItem('sftpUsername');
                const password = this.storageSettings.getItem('sftpPassword');
                const targetDirectory = this.storageSettings.getItem('sftpTargetDirectory');

                return new Sftp(
                    {
                        host,
                        port,
                        username,
                        password,
                    },
                    targetDirectory,
                    this.console);
            }
        } catch (e) {
            this.console.log('Error during service init', e);
        }
    }

    async executeBackup(date: Date) {
        const filePrefix = this.storageSettings.getItem('filePrefix');
        const { fileName, filePath } = await this.localService.createBackup({ date, filePrefix });

        const service = this.storageSettings.values.backupService as BackupServiceEnum;

        const serviceClient = await this.getBackupService();
        this.console.log(`Starting upload to ${service}.`);
        await serviceClient.uploadBackup({ fileName, filePath });
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

    async restoreBackup() {
        const restoreSource = this.storageSettings.getItem('restoreSource') as RestoreSource;
        const backupToRestore = this.storageSettings.getItem('backupToRestore');

        this.storageSettings.putSetting('backupToRestore', undefined);

        this.console.log(`Restoring backup ${backupToRestore} from ${restoreSource}`);

        let buffer: Buffer;

        if (restoreSource === RestoreSource.Cloud) {
            const cloudClient = await this.getBackupService();
            buffer = await cloudClient.getBackup({ fileName: backupToRestore });
        } else {
            buffer = await this.localService.getBackup({ fileName: backupToRestore });
        }

        await this.localService.uploadBackup({ buffer });
    }
}