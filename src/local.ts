import sdk from "@scrypted/sdk";
import { BackupService, fileExtension, findFilesToRemove } from "./types";
import fs from "fs"
import path from 'path';
import { getScryptedVolume } from '../../scrypted/server/src/plugin/plugin-volume';

export class Local implements BackupService {
    private defaultBackupFolder = path.join(process.env.SCRYPTED_PLUGIN_VOLUME, 'backups');
    constructor(public console: Console) { }

    log(message?: any, ...optionalParams: any[]) {
        this.console.log(`[LOCAL] `, message, ...optionalParams);
    }

    async uploadBackup(props: { buffer?: Buffer }): Promise<void> {
        const bkup = await sdk.systemManager.getComponent('backup');
        await bkup.restoreBackup(props.buffer);
    }

    async getBackupsList(props: { filePrefix: string, backupFolder?: string }): Promise<string[]> {
        const { filePrefix, backupFolder = this.defaultBackupFolder } = props;
        const allFiles = (await fs.promises.readdir(backupFolder)).filter(fileName => fileName.startsWith(filePrefix));

        const { filesOrderedByDate } = findFilesToRemove({ fileNames: allFiles, filePrefix });

        return filesOrderedByDate;
    }

    async getBackup(props: { fileName: string, backupFolder?: string }) {
        const { fileName, backupFolder = this.defaultBackupFolder } = props;
        this.log(`Looking for the backup ${fileName}`);

        try {
            return await fs.promises.readFile(`${backupFolder}/${fileName}`);
        } catch (e) {
            this.log('Error finding the backup', e);
            return;
        }
    }

    private getFileNames(props: { now: Date, filePrefix: string, backupFolder?: string }) {
        const { backupFolder = this.defaultBackupFolder, filePrefix, now } = props;
        const date = `${now.getFullYear()}_${now.getMonth() + 1}_${now.getDate()}_${now.getHours()}_${now.getMinutes()}_${now.getSeconds()}`;
        const fileName = `${filePrefix}-${date}${fileExtension}`;

        const filePath = `${backupFolder}/${fileName}`;

        return {
            fileName,
            filePath,
        }
    }

    async createBackup(props: { date: Date, filePrefix: string, backupFolder?: string }) {
        this.log(`Starting backup download.`);

        try {
            const { filePrefix, date, backupFolder = this.defaultBackupFolder } = props;
            if (!fs.existsSync(backupFolder)) {
                this.log(`Creating backups dir at: ${backupFolder}`)
                fs.mkdirSync(backupFolder);
            }

            // Make sure to cleanup backups on the local folder to fix a possible issue on the server
            const volumeDir = getScryptedVolume();
            const backupDbPath = path.join(volumeDir, 'backup.db');
            await fs.promises.rm(backupDbPath, {
                recursive: true,
                force: true,
                maxRetries: 10,
            });
            const backupZip = path.join(volumeDir, 'backup.zip');
            await fs.promises.rm(backupZip, {
                recursive: true,
                force: true,
                maxRetries: 10,
            });

            const bkup = await sdk.systemManager.getComponent('backup');
            const buffer = await bkup.createBackup();

            const { filePath, fileName } = this.getFileNames({ now: date, filePrefix, backupFolder });

            await fs.promises.writeFile(filePath, buffer);

            this.log(`Backup download completed.`);
            return { filePath, fileName };
        } catch (e) {
            this.log('Error downloading backup', e);
            return;
        }
    }

    async restoreBackup(props: { fileBuffer: Buffer }) {
        this.log(`Starting backup restore.`);
        const { fileBuffer } = props;

        try {
            const bkup = await sdk.systemManager.getComponent('backup');
            await bkup.restore(fileBuffer);

            this.log(`Backup restore completed.`);
        } catch (e) {
            this.log('Error restore backup', e);
            return;
        }
    }

    async pruneOldBackups(props: { maxBackups: number; filePrefix: string, backupFolder?: string }): Promise<number> {
        const { filePrefix, maxBackups, backupFolder = this.defaultBackupFolder } = props;
        const allFiles = (await fs.promises.readdir(backupFolder)).filter(fileName => fileName.startsWith(filePrefix));

        const { filesToRemove } = findFilesToRemove({ fileNames: allFiles, filesToKeep: maxBackups, filePrefix });
        const filesCountToRemove = filesToRemove.length;

        if (filesCountToRemove > 0) {
            this.log(`Removing ${filesCountToRemove} old backups`);
            for (const fileName of filesToRemove) {
                try {
                    await fs.promises.unlink(`${backupFolder}/${fileName}`);
                    this.log(`File ${fileName} removed`);
                } catch (e) {
                    this.log(`Error removing file ${fileName}`, e);
                }
            }
        }

        return filesCountToRemove;
    }
}