# Scrypted remote backup

https://github.com/apocaliss92/scrypted-remote-backup - For requests and bugs

This allow allows the backup of the scrypted server cron bases.

Supported services
- Local - backups are stored in the plugin folder
- Samba (requires smbclient installed on host)
    - MacOS (homebrew):
        - brew install samba
        - touch /opt/homebrew/etc/smb.conf
    -  Proxmox script
        - run apt install smbclient -y

Use this link to calculate your cron string 
- https://crontab.guru/#0_5_*_*_* 
- https://www.npmjs.com/package/node-cron 

TODO
- Show error notification if samba is not installed on host
- As soon as another service will be implemented, create an interface and implement for each service