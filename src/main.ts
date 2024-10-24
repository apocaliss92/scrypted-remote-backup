import sdk, { ScryptedDeviceBase, Setting, SettingValue } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import axios from "axios";
import cron, { ScheduledTask } from 'node-cron';
import SambaClient from 'samba-client';
import fs from "fs"
import path from 'path';
import orderBy from 'lodash/orderBy'

const getStringifiedNumbers = (start: number, end: number) => ([
    '*',
    ...Array.from(Array(end + start).keys()).map(i => String(i + start))
]);
enum BackupService {
    Samba = 'Samba'
}
const backupServices: BackupService[] = [BackupService.Samba];
const BACKUP_FOLDER = path.join(process.env.SCRYPTED_PLUGIN_VOLUME, 'backups');
const fileExtension = '.zip';

export default class RemoteBackup extends ScryptedDeviceBase {
    private cronTask: ScheduledTask;

    storageSettings = new StorageSettings(this, {
        pluginEnabled: {
            title: 'Plugin enabled',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        scryptedAddress: {
            title: 'Scrypted address',
            type: 'string',
        },
        scryptedToken: {
            title: 'Scrypted token',
            type: 'string',
        },
        backupService: {
            title: 'Backup service',
            type: 'string',
            choices: backupServices,
            defaultValue: backupServices[0]
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
        maxBackupsLocal: {
            title: 'Max backups to keep locally',
            group: 'Retention',
            type: 'number',
            defaultValue: 7,
        },
        maxBackupsCloud: {
            title: 'Max backups to keep on cloud',
            group: 'Retention',
            type: 'number',
            defaultValue: 7,
        },
        filePrefix: {
            title: 'File prefix. Should not contain the character "_"',
            group: 'Retention',
            type: 'string',
            defaultValue: 'scrypted-backup'
        },
        backupNow: {
            title: 'Execute backup',
            group: 'Retention',
            type: 'button',
            onPut: async () => await this.executeBackup(new Date())
        },
        checkFiles: {
            title: 'Check files',
            group: 'Retention',
            type: 'button',
        },
        dayOfWeek: {
            title: 'Day in the week',
            group: 'Scheduler',
            type: 'string',
            choices: getStringifiedNumbers(1, 7),
            defaultValue: '*'
        },
        month: {
            title: 'Month',
            group: 'Scheduler',
            type: 'string',
            choices: getStringifiedNumbers(1, 12),
            defaultValue: '*'
        },
        dayOfMonth: {
            title: 'Day in the month',
            type: 'string',
            group: 'Scheduler',
            choices: getStringifiedNumbers(1, 31),
            defaultValue: '*'
        },
        hour: {
            title: 'Hour',
            group: 'Scheduler',
            type: 'string',
            choices: getStringifiedNumbers(0, 23),
            defaultValue: '4'
        },
        minute: {
            title: 'Minute',
            group: 'Scheduler',
            type: 'string',
            choices: getStringifiedNumbers(0, 59),
            defaultValue: '0'
        },
        second: {
            title: 'Second',
            group: 'Scheduler',
            type: 'string',
            choices: getStringifiedNumbers(0, 59),
            defaultValue: '*'
        },
    });

    constructor(nativeId: string) {
        super(nativeId);

        const keysToReinitialize: (keyof typeof this.storageSettings.settings)[] = [
            'second',
            'minute',
            'hour',
            'dayOfWeek',
            'month',
            'dayOfMonth',
            'pluginEnabled',
        ]

        keysToReinitialize.forEach(key => this.storageSettings.settings[key].onPut = async () => this.initScheduler());

        this.storageSettings.settings.checkFiles.onPut = async () => await this.checkMaxFiles();
        this.initScheduler().then().catch(console.log);
    }

    async getSettings() {

        const backupService = this.storageSettings.getItem('backupService');

        if (backupService === BackupService.Samba) {
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

            const second = this.storageSettings.getItem('second') || '*';
            const minute = this.storageSettings.getItem('minute') || '*';
            const hour = this.storageSettings.getItem('hour') || '*';
            const dayOfMonth = this.storageSettings.getItem('dayOfMonth') || '*';
            const month = this.storageSettings.getItem('month') || '*';
            const dayOfWeek = this.storageSettings.getItem('dayOfWeek') || '*';

            const cronTime = `${second} ${minute} ${hour} ${dayOfMonth} ${month} ${dayOfWeek}`;
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

    private getFileNames(now: Date) {
        const prefix = this.storageSettings.getItem('filePrefix') || 'scrypted-backup';
        const date = `${now.getFullYear()}_${now.getMonth() + 1}_${now.getDate()}_${now.getHours()}_${now.getMinutes()}_${now.getSeconds()}`;
        const fileName = `${prefix}-${date}${fileExtension}`;

        const filePath = `${BACKUP_FOLDER}/${fileName}`;

        return {
            fileName,
            filePath,
        }
    }

    async downloadBackup(date: Date) {
        this.console.log('Starting backup download');
        const scryptedAddress = this.storageSettings.getItem('scryptedAddress');
        const scryptedToken = this.storageSettings.getItem('scryptedToken');

        if (!scryptedAddress || !scryptedToken) {
            this.console.log('Scrypted address or token not set');

            return;
        }

        try {
            const response = await axios.get(`${scryptedAddress}/web/component/backup`, {
                responseType: 'arraybuffer',
                headers: {
                    'Authorization': `Bearer ${scryptedToken}`,
                },
            });

            const buffer = Buffer.from(response.data as any);
            const fileSize = (buffer.length * 0.001).toFixed(1);
            console.log(`Downloaded successfull. File size: ${fileSize} mb.`);

            if (!fs.existsSync(BACKUP_FOLDER)) {
                this.console.log(`Creating backups dir at: ${BACKUP_FOLDER}`)
                fs.mkdirSync(BACKUP_FOLDER);
            }

            const { filePath, fileName } = this.getFileNames(date);

            await fs.promises.writeFile(filePath, buffer);

            return { filePath, fileName };
        } catch (e) {
            this.console.log('Error downloading backup', e);
            return;
        }
    }
    // const ep = await sdk.endpointManager.getLocalEndpoint();
    // const fileURLToPath = url.pathToFileURL(filePath).toString()
    // return await sdk.mediaManager.createMediaObjectFromUrl(fileURLToPath);

    async executeBackup(date: Date) {
        const backupService = this.storageSettings.getItem('backupService') as BackupService;

        const { fileName, filePath } = await this.downloadBackup(date);

        if (backupService === BackupService.Samba) {
            await this.executeBackupSamba(fileName, filePath);
        }
    }

    async getSambaClient() {
        const address = this.storageSettings.getItem('sambaAddress');
        const username = this.storageSettings.getItem('sambaUsername');
        const password = this.storageSettings.getItem('sambaPassword');
        const domain = this.storageSettings.getItem('sambaDomain');
        const maxProtocol = this.storageSettings.getItem('sambaMaxProtocol');
        const maskCmd = this.storageSettings.getItem('sambaMaskCmd');
        const directory = this.storageSettings.getItem('sambaTargetDirectory');

        if (!address) {
            this.console.log('Address and targetDirectory are required');

            return;
        }

        let client: SambaClient;

        try {
            client = new SambaClient({
                address,
                username,
                password,
                domain,
                maxProtocol,
                maskCmd,
                directory
            });
        } catch (e) {
            this.console.log('Error during Samba connection', e);
            return;
        }

        return client;
    }

    async executeBackupSamba(fileName: string, filePath: string) {
        const client = await this.getSambaClient();

        const dst = fileName;
        this.console.log(`Uploading file to SMB. Source path is ${filePath}, destination is :${dst}`);
        try {
            await client.sendFile(filePath, dst);
        } catch (e) {
            this.console.log('Error uploading backup to SMB', e);
        }

        this.console.log(`Upload to SMB completed.`);
    }

    async checkMaxFiles() {
        const backupService = this.storageSettings.getItem('backupService') as BackupService;

        if (backupService === BackupService.Samba) {
            await this.checkSambaMaxFiles();
        }

        await this.checkLocalMaxFiles();
    }

    private parseFiles(fileNames: string[], filesToKeep: number) {
        const filePrefix = this.storageSettings.getItem('filePrefix') as BackupService;
        const fileDateMap: Record<string, number> = {};
        for (const fileName of fileNames) {
            const fileDate = fileName.split(filePrefix)[1].replace(fileExtension, '').replace('-', '');
            const [year, month, day, hour, minute, second] = fileDate.split('_');
            const date = new Date();

            date.setFullYear(Number(year));
            date.setMonth(Number(month));
            date.setDate(Number(day));
            date.setHours(Number(hour));
            date.setMinutes(Number(minute));
            date.setSeconds(Number(second));
            date.setMilliseconds(0);

            fileDateMap[fileName] = date.getTime();
        }

        const filesOrderedByDate = orderBy(fileNames, fileName => fileDateMap[fileName], 'asc');
        const filesCountToRemove = filesOrderedByDate.length - filesToKeep;
        const filesToRemove = filesOrderedByDate.splice(0, filesCountToRemove);

        return filesToRemove;
    }

    async checkSambaMaxFiles() {
        this.console.log(`Starting Samba cleanup`);
        const maxBackupsCloud = this.storageSettings.getItem('maxBackupsCloud') as number;
        const client = await this.getSambaClient();
        const filePrefix = this.storageSettings.getItem('filePrefix') as BackupService;
        const allFiles = await client.listFiles(filePrefix, fileExtension);

        const filesToRemove = this.parseFiles(allFiles, maxBackupsCloud);
        const filesCountToRemove = filesToRemove.length;

        if (filesCountToRemove > 0) {
            this.console.log(`Removing ${filesCountToRemove} old backups`);
            for (const fileName of filesToRemove) {
                try {
                    await client.deleteFile(fileName);
                    this.console.log(`File ${fileName} removed`);
                } catch (e) {
                    this.console.log(`Error removing file ${fileName}`, e);
                }
            }
            this.console.log(`Samba cleanup completed`);
        } else {
            this.console.log(`Nothing to cleanup on Samba`);
        }
    }

    async checkLocalMaxFiles() {
        this.console.log(`Starting Local cleanup`);
        const maxBackupsLocal = this.storageSettings.getItem('maxBackupsLocal') as number;
        const filePrefix = this.storageSettings.getItem('filePrefix') as BackupService;
        const allFiles = (await fs.promises.readdir(BACKUP_FOLDER)).filter(fileName => fileName.startsWith(filePrefix));

        const filesToRemove = this.parseFiles(allFiles, maxBackupsLocal);
        const filesCountToRemove = filesToRemove.length;

        if (filesCountToRemove > 0) {
            this.console.log(`Removing ${filesCountToRemove} old backups`);
            for (const fileName of filesToRemove) {
                try {
                    await fs.promises.unlink(`${BACKUP_FOLDER}/${fileName}`);
                    this.console.log(`File ${fileName} removed`);
                } catch (e) {
                    this.console.log(`Error removing file ${fileName}`, e);
                }
            }
            this.console.log(`Samba cleanup completed`);
        } else {
            this.console.log(`Nothing to cleanup on Samba`);
        }
    }
}