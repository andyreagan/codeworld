       IDENTIFICATION DIVISION.
       PROGRAM-ID. PBSTMT.
      * Monthly premium statements: one per active policy, listing
      * the month's bills from the billing history.
       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
           SELECT STMT-FILE ASSIGN TO STMTOUT.
       DATA DIVISION.
       FILE SECTION.
       FD  STMT-FILE.
       01  STMT-LINE               PIC X(133).
       WORKING-STORAGE SECTION.
           EXEC SQL INCLUDE SQLCA END-EXEC.
           EXEC SQL DECLARE BILLS CURSOR FOR
               SELECT P.POL_NUMBER, P.OWNER_NAME, P.OWNER_ADDR,
                      H.PREMIUM, H.DUE_DATE
                 FROM POLICY P
                 JOIN BILLING_HIST H ON H.POL_NUMBER = P.POL_NUMBER
                WHERE P.STATUS = 'A'
                ORDER BY P.POL_NUMBER
           END-EXEC.
       01  WS-ADDR-BLOCK           PIC X(200).
       01  WS-ADDRESS              PIC X(120).
       PROCEDURE DIVISION.
       MAIN-LINE SECTION.
       0000-START.
           OPEN OUTPUT STMT-FILE
           EXEC SQL OPEN BILLS END-EXEC
           PERFORM 1000-NEXT-BILL UNTIL SQLCODE NOT = 0
           EXEC SQL CLOSE BILLS END-EXEC
           CLOSE STMT-FILE.
       0000-END.
           GOBACK.
       STATEMENT SECTION.
       1000-NEXT-BILL.
           EXEC SQL FETCH BILLS INTO :WS-ADDRESS END-EXEC
           IF SQLCODE = 0
               CALL 'PBFMTADR' USING WS-ADDRESS WS-ADDR-BLOCK
               PERFORM 1100-WRITE-LINES
           END-IF.
       1100-WRITE-LINES.
           WRITE STMT-LINE FROM WS-ADDR-BLOCK.
