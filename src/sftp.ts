import SftpClient from "ssh2-sftp-client";
import { BackupService, fileExtension, findFilesToRemove } from "./types";

export class Sftp implements BackupService {
    private client: SftpClient;
    constructor(
        private connectOptions: SftpClient.ConnectOptions, 
        private targetDirectory: string, 
        public console: Console
    ) {
    }

    downloadBackup(props: { filePrefix: string, targetDirectory?: string }): Promise<Buffer> {
        throw new Error("Method not implemented.");
    }

    private async getClient() {
        if (this.client) {
            await this.client.end();
            this.client = undefined;
        }

        this.client = new SftpClient();
        await this.client.connect(this.connectOptions);

        return this.client;
    }

    async uploadBackup(props: { fileName: string; filePath: string; }) {
        const { fileName, filePath } = props;
        const dst = `${this.targetDirectory}/${fileName}`;
        this.console.log(`Uploading file to SFTP. Source path is ${filePath}, destination is ${dst}`);
        const client = await this.getClient();
        try {
            await client.put(filePath, dst);
        } catch (e) {
            this.console.log('Error uploading backup to SMB', e);
        }
    }

    async pruneOldBackups(props: { maxBackups: number; filePrefix: string }) {
        const { filePrefix, maxBackups } = props;
        const client = await this.getClient();

        const allFiles = await client.list(this.targetDirectory, file => file.name.endsWith(fileExtension));
        const allFileNames = allFiles.map(file => file.name);

        const filesToRemove = findFilesToRemove({ fileNames: allFileNames, filesToKeep: maxBackups, filePrefix });
        const filesCountToRemove = filesToRemove.length;

        if (filesCountToRemove > 0) {
            for (const fileName of filesToRemove) {
                try {
                    const filePAth = `${this.targetDirectory}/${fileName}`;
                    await client.delete(fileName);
                    this.console.log(`File ${fileName} removed`);
                } catch (e) {
                    this.console.log(`Error removing file ${fileName}`, e);
                }
            }
        }

        return filesCountToRemove;
    }
}