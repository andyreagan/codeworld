       IDENTIFICATION DIVISION.
       PROGRAM-ID. PBPOST.
      * Posts the night's extract to DB2: brings each policy's paid-to
      * date forward and records the bill in the billing history.
       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
           SELECT EXTRACT-FILE ASSIGN TO EXTIN.
           SELECT POSTED-FILE  ASSIGN TO POSTOUT.
       DATA DIVISION.
       FILE SECTION.
       FD  EXTRACT-FILE.
       01  EXTRACT-REC.
           05  EXT-POL-NUMBER      PIC X(10).
           05  EXT-PREMIUM         PIC S9(7)V99 COMP-3.
           05  EXT-DUE-DATE        PIC X(8).
       FD  POSTED-FILE.
       01  POSTED-REC              PIC X(40).
       WORKING-STORAGE SECTION.
           EXEC SQL INCLUDE SQLCA END-EXEC.
           EXEC SQL DECLARE OVERDUE CURSOR FOR
               SELECT POL_NUMBER, PAID_TO
                 FROM POLICY
                WHERE PAID_TO < CURRENT DATE - 60 DAYS
           END-EXEC.
       01  WS-EOF                  PIC X VALUE 'N'.
       PROCEDURE DIVISION.
       0000-MAIN.
           OPEN INPUT EXTRACT-FILE OUTPUT POSTED-FILE
           PERFORM 1000-POST UNTIL WS-EOF = 'Y'
           PERFORM 2000-FLAG-OVERDUE
           CLOSE EXTRACT-FILE POSTED-FILE
           GOBACK.
       1000-POST.
           READ EXTRACT-FILE
               AT END MOVE 'Y' TO WS-EOF
               NOT AT END
                   PERFORM 1100-UPDATE-POLICY
                   PERFORM 1200-INSERT-HISTORY
                   WRITE POSTED-REC FROM EXTRACT-REC
           END-READ.
       1100-UPDATE-POLICY.
           EXEC SQL
               UPDATE POLICY
                  SET PAID_TO = :EXT-DUE-DATE
                WHERE POL_NUMBER = :EXT-POL-NUMBER
           END-EXEC.
       1200-INSERT-HISTORY.
           EXEC SQL
               INSERT INTO BILLING_HIST
                      (POL_NUMBER, PREMIUM, DUE_DATE)
               VALUES (:EXT-POL-NUMBER, :EXT-PREMIUM, :EXT-DUE-DATE)
           END-EXEC.
      * Anything 60 days behind goes to the lapse notice queue.
       2000-FLAG-OVERDUE.
           EXEC SQL OPEN OVERDUE END-EXEC
           PERFORM UNTIL SQLCODE NOT = 0
               EXEC SQL FETCH OVERDUE INTO :EXT-POL-NUMBER,
                                          :EXT-DUE-DATE
               END-EXEC
               IF SQLCODE = 0
                   EXEC SQL
                       INSERT INTO LAPSE_NOTICE (POL_NUMBER)
                       VALUES (:EXT-POL-NUMBER)
                   END-EXEC
               END-IF
           END-PERFORM
           EXEC SQL CLOSE OVERDUE END-EXEC.
