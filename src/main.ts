import sdk, { Setting, SettingValue } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import cron, { ScheduledTask } from 'node-cron';
import { Samba } from "./samba";
import { BackupServiceEnum } from "./types";
import { Local } from "./local";
import { Sftp } from "./sftp";
import { BasePlugin, getBaseSettings } from '../../scrypted-apocaliss-base/src/basePlugin';

enum RestoreSource {
    Local = 'Local',
    Cloud = 'Cloud',
}

export default class RemoteBackup extends BasePlugin {
    private cronTask: ScheduledTask;
    private localService: Local;

    storageSettings = new StorageSettings(this, {
        ...getBaseSettings({
            onPluginSwitch: async (oldValue, newValue) => {
                await this.startStop(newValue);
            },
        }),
        backupService: {
            title: 'Backup service',
            type: 'string',
            choices: [BackupServiceEnum.Samba, BackupServiceEnum.OnlyLocal, BackupServiceEnum.SFTP],
            defaultValue: BackupServiceEnum.OnlyLocal,
            immediate: true,
        },
        maxBackupsLocal: {
            title: 'Max local backups',
            description: 'Maximum amount of backups to retain on the scrypted\' plugin folder',
            type: 'number',
            defaultValue: 7,
        },
        maxBackupsCloud: {
            title: 'Max cloud backups',
            description: 'Maximum amount of backups to retain on the selected backup service',
            type: 'number',
            defaultValue: 7,
            hide: true,
        },
        filePrefix: {
            title: 'File prefix. Should not contain the character "_"',
            type: 'string',
            defaultValue: 'scrypted-backup'
        },
        cronSchedule: {
            title: 'Cron scheduler',
            type: 'string',
            defaultValue: '0 4 * * *',
            onPut: async () => await this.start()
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
        super(nativeId, {
            pluginFriendlyName: 'Remote backup',
        });


        this.localService = new Local(this.getLogger());

        this.fetchFiles().then().catch(this.getLogger().log);
        this.start().then().catch(this.getLogger().log);
    }

    async startStop(enabled: boolean) {
        if (enabled) {
            await this.start();
        } else {
            await this.stop();
        }
    }

    async start() {
        if (!this.storageSettings.getItem('pluginEnabled')) {
            this.getLogger().log('Plugin is disabled');

            return;
        }
        await this.stop();

        await this.initScheduler();
    }

    async stop() {
        if (this.cronTask) {
            this.getLogger().log('Stopping scheduler');
            this.cronTask.stop();
            this.cronTask = undefined;
        }
    }

    async getSettings() {
        const backupService = this.storageSettings.getItem('backupService');
        const allServices = this.storageSettings.settings.backupService.choices;

        this.storageSettings.settings.maxBackupsCloud.hide = backupService === BackupServiceEnum.OnlyLocal;

        Object.entries(this.storageSettings.settings).forEach(([_, setting]) => {
            if (setting.group === backupService) {
                setting.hide = false;
            } else if (allServices.includes(setting.group)) {
                setting.hide = true;
            }
        })

        const settings: Setting[] = await super.getSettings();

        return settings;
    }

    async fetchFiles() {
        const filePrefix = this.storageSettings.getItem('filePrefix');
        const restoreSource = this.storageSettings.getItem('restoreSource') as RestoreSource;

        this.getLogger().log(`Fetching available backups`);
        try {
            let backups = [];
            if (restoreSource === RestoreSource.Local) {
                const cloudService = await this.getBackupService();
                backups = await cloudService.getBackupsList({ filePrefix });
            } else {
                backups = await this.localService.getBackupsList({ filePrefix });
            }
            this.getLogger().log(`${backups.length} backups found.`);
            this.storageSettings.settings.backupToRestore.choices = backups;
        } catch (e) {
            this.getLogger().log('Error fetching available backups', e);
        };
    }

    async initScheduler() {
        try {
            const { cronSchedule, devNotifier, backupService } = this.storageSettings.values;
            if (!cronSchedule) {
                this.getLogger().log(`Cron scheduler is not set`);

                return;
            }

            this.getLogger().log(`Starting scheduler with ${cronSchedule}`);

            this.cronTask = cron.schedule(cronSchedule, async () => {
                try {
                    const now = new Date();
                    this.getLogger().log(`Executing scheduled backup at ${now.toLocaleString()}`);
                    await this.executeBackup(now);

                    const { localFilesRemoved, serviceFilesRemoved } = await this.checkMaxFiles();

                    if (devNotifier) {
                        let message = `Backup executed on ${backupService}.\n`;
                        message += `${serviceFilesRemoved} backups removed on ${backupService}\n`;
                        message += `${localFilesRemoved} backups removed locally`;
                        await devNotifier.sendNotification(this.opts.pluginFriendlyName, {
                            body: message
                        })
                    }
                } catch (e) {
                    this.getLogger().log('Error executing the scheduled backup: ', e);
                    if (devNotifier) {
                        await devNotifier.sendNotification(this.opts.pluginFriendlyName, {
                            body: `Error executing backup: ${e}`
                        })
                    }
                }
            });
        } catch (e) {
            this.getLogger().log('Error in initScheduler', e);
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
                }, this.getLogger());
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
                    this.getLogger());
            }
        } catch (e) {
            this.getLogger().log('Error during service init', e);
        }
    }

    async executeBackup(date: Date) {
        const logger = this.getLogger();
        const { filePrefix, backupService } = this.storageSettings.values;
        const { fileName, filePath } = await this.localService.createBackup({ date, filePrefix });

        if (backupService !== BackupServiceEnum.OnlyLocal) {
            const serviceClient = await this.getBackupService();
            logger.log(`Starting upload to ${backupService}.`);
            await serviceClient.uploadBackup({ fileName, filePath });
            logger.log(`Upload to ${backupService} completed.`);
        } else {
            logger.log(`Skipping cloud backup.`);
        }
    }

    async checkMaxFiles() {
        const { backupService, maxBackupsCloud, maxBackupsLocal, filePrefix } = this.storageSettings.values;

        const cloudClient = await this.getBackupService();
        this.getLogger().log(`Starting ${backupService} max filess cleanup.`);
        const serviceFilesRemoved = await cloudClient.pruneOldBackups({ filePrefix, maxBackups: maxBackupsCloud });
        this.getLogger().log(`${backupService} max files cleanup completed. Removed ${serviceFilesRemoved} backups.`);

        this.getLogger().log(`Starting local max filess cleanup.`);
        const localFilesRemoved = await this.localService.pruneOldBackups({ filePrefix, maxBackups: maxBackupsLocal });
        this.getLogger().log(`Local max files cleanup completed. Removed ${localFilesRemoved} backups.`);

        return { serviceFilesRemoved, localFilesRemoved }
    }

    async restoreBackup() {
        const { restoreSource, backupToRestore } = this.storageSettings.values;

        this.storageSettings.putSetting('backupToRestore', undefined);

        this.getLogger().log(`Restoring backup ${backupToRestore} from ${restoreSource}`);

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