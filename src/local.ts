import sdk from "@scrypted/sdk";
import { fileExtension, findFilesToRemove } from "./types";
import fs from "fs"

export class Local {
    constructor(public backupFolder: string, public console: Console) { }

    private getFileNames(now: Date, filePrefix: string) {
        const date = `${now.getFullYear()}_${now.getMonth() + 1}_${now.getDate()}_${now.getHours()}_${now.getMinutes()}_${now.getSeconds()}`;
        const fileName = `${filePrefix}-${date}${fileExtension}`;

        const filePath = `${this.backupFolder}/${fileName}`;

        return {
            fileName,
            filePath,
        }
    }

    async downloadBackup(props: { filePrefix: string; date: Date }) {
        this.console.log(`Starting backup download.`);

        try {
            const { filePrefix, date } = props;
            if (!fs.existsSync(this.backupFolder)) {
                this.console.log(`Creating backups dir at: ${this.backupFolder}`)
                fs.mkdirSync(this.backupFolder);
            }

            const bkup = await sdk.systemManager.getComponent('backup');
            const buffer = await bkup.createBackup();

            const { filePath, fileName } = this.getFileNames(date, filePrefix);

            await fs.promises.writeFile(filePath, buffer);

            this.console.log(`Backup download completed.`);
            return { filePath, fileName };
        } catch (e) {
            this.console.log('Error downloading backup', e);
            return;
        }
    }

    async pruneOldBackups(props: { maxBackups: number; filePrefix: string; }): Promise<number> {
        const { filePrefix, maxBackups } = props;
        const allFiles = (await fs.promises.readdir(this.backupFolder)).filter(fileName => fileName.startsWith(filePrefix));

        const filesToRemove = findFilesToRemove({ fileNames: allFiles, filesToKeep: maxBackups, filePrefix });
        const filesCountToRemove = filesToRemove.length;

        if (filesCountToRemove > 0) {
            this.console.log(`Removing ${filesCountToRemove} old backups`);
            for (const fileName of filesToRemove) {
                try {
                    await fs.promises.unlink(`${this.backupFolder}/${fileName}`);
                    this.console.log(`File ${fileName} removed`);
                } catch (e) {
                    this.console.log(`Error removing file ${fileName}`, e);
                }
            }
        }

        return filesCountToRemove;
    }
}