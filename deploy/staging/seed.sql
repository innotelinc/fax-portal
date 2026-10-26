-- Staging seed. Mirrors the columns the portal reads from the legacy schema so
-- the portal's own tables (PortalJob, PortalTriage, …) are created against the
-- same shape they will meet in production. STAGING ONLY: no production data.
CREATE TABLE IF NOT EXISTS UserAccount (
  uid INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(128) NULL,
  email VARCHAR(190) NOT NULL,
  password VARCHAR(255) NOT NULL,
  pwdcycle INT NOT NULL DEFAULT 0,
  is_admin TINYINT NOT NULL DEFAULT 0,
  acc_enabled TINYINT NOT NULL DEFAULT 1,
  wasreset TINYINT NOT NULL DEFAULT 0,
  language VARCHAR(8) NOT NULL DEFAULT 'en'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS FaxArchive (
  faxid INT AUTO_INCREMENT PRIMARY KEY,
  uid INT NOT NULL,
  faxfname VARCHAR(255) NOT NULL,
  faxnumber VARCHAR(32) NOT NULL DEFAULT '',
  sender VARCHAR(64) NOT NULL DEFAULT '',
  modem VARCHAR(32) NOT NULL DEFAULT '',
  pages INT NOT NULL DEFAULT 0,
  faxdate DATETIME NULL,
  faxstamp DATETIME NULL,
  archived TINYINT NOT NULL DEFAULT 0,
  KEY uid_date (uid, faxdate)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO UserAccount (username, name, email, password, is_admin, acc_enabled) VALUES
  ('stage-client', 'Staging Client', 'stage-client@lab.innotel.us', '!sso-only-no-password!', 0, 1),
  ('stage-admin', 'Staging Administrator', 'stage-admin@lab.innotel.us', '!sso-only-no-password!', 1, 1);

INSERT INTO FaxArchive (uid, faxfname, faxnumber, sender, modem, pages, faxdate) VALUES
  (1, 'welcome.pdf', '+15550001111', 'Innotel Fax staging', 'stub0', 1, UTC_TIMESTAMP());
