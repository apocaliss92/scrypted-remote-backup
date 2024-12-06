import sdk from "@scrypted/sdk";
import { BackupService, fileExtension, findFilesToRemove } from "./types";
import fs from "fs"
import path from 'path';

export class Local implements BackupService {
    private backupFolder = path.join(process.env.SCRYPTED_PLUGIN_VOLUME, 'backups');

    constructor(public console: Console) { }

    log(message?: any, ...optionalParams: any[]) {
        this.console.log(`[LOCAL] `, message, ...optionalParams);
    }

    async uploadBackup(props: { buffer?: Buffer }): Promise<void> {
        const bkup = await sdk.systemManager.getComponent('backup');
        await bkup.restoreBackup(props.buffer);
    }

    async getBackupsList(props: { filePrefix: string; }): Promise<string[]> {
        const { filePrefix } = props;
        const allFiles = (await fs.promises.readdir(this.backupFolder)).filter(fileName => fileName.startsWith(filePrefix));

        const { filesOrderedByDate } = findFilesToRemove({ fileNames: allFiles, filePrefix });

        return filesOrderedByDate;
    }

    async getBackup(props: { fileName: string }) {
        const { fileName } = props;
        this.log(`Looking for the backup ${fileName}`);

        try {
            return await fs.promises.readFile(`${this.backupFolder}/${fileName}`);
        } catch (e) {
            this.log('Error finding the backup', e);
            return;
        }
    }

    private getFileNames(now: Date, filePrefix: string) {
        const date = `${now.getFullYear()}_${now.getMonth() + 1}_${now.getDate()}_${now.getHours()}_${now.getMinutes()}_${now.getSeconds()}`;
        const fileName = `${filePrefix}-${date}${fileExtension}`;

        const filePath = `${this.backupFolder}/${fileName}`;

        return {
            fileName,
            filePath,
        }
    }

    async createBackup(props: { date: Date, filePrefix: string }) {
        this.log(`Starting backup download.`);

        try {
            const { filePrefix, date } = props;
            if (!fs.existsSync(this.backupFolder)) {
                this.log(`Creating backups dir at: ${this.backupFolder}`)
                fs.mkdirSync(this.backupFolder);
            }

            const bkup = await sdk.systemManager.getComponent('backup');
            const buffer = await bkup.createBackup();

            const { filePath, fileName } = this.getFileNames(date, filePrefix);

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

    async pruneOldBackups(props: { maxBackups: number; filePrefix: string; }): Promise<number> {
        const { filePrefix, maxBackups } = props;
        const allFiles = (await fs.promises.readdir(this.backupFolder)).filter(fileName => fileName.startsWith(filePrefix));

        const { filesToRemove } = findFilesToRemove({ fileNames: allFiles, filesToKeep: maxBackups, filePrefix });
        const filesCountToRemove = filesToRemove.length;

        if (filesCountToRemove > 0) {
            this.log(`Removing ${filesCountToRemove} old backups`);
            for (const fileName of filesToRemove) {
                try {
                    await fs.promises.unlink(`${this.backupFolder}/${fileName}`);
                    this.log(`File ${fileName} removed`);
                } catch (e) {
                    this.log(`Error removing file ${fileName}`, e);
                }
            }
        }

        return filesCountToRemove;
    }
}